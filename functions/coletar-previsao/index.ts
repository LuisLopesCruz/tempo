// ============================================================================
// TEMPO-RJ — coletor de previsão (Open-Meteo, multi-linhagem)
// ----------------------------------------------------------------------------
// Roda no Supabase Edge Runtime, acionado por pg_cron. O HTML NUNCA coleta:
// se ninguém abrisse a página, o histórico teria buracos e a verificação
// (o bloco que separa isto de um mashup de APIs) seria impossível.
//
// Grava UMA linha JSONB por (ponto, linhagem, hora-de-emissão) — 120 passos
// horários viram um blob, não 120 linhas. É o que cabe nos 500 MB.
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const OM = "https://api.open-meteo.com/v1/forecast";
const FORECAST_DAYS = 5;
const CHUNK = 20;          // pontos por requisição
const PAUSA_MS = 400;      // gentileza com a API gratuita

// Segredo compartilhado com pg_cron (tempo.config). Fica apenas no servidor:
// nunca e enviado ao navegador. Evita depender da service_role key, que o
// MCP nao expoe, e impede que a URL publica da funcao seja acionada por
// terceiros (protegendo a cota da API gratuita da Open-Meteo).
const SEGREDO = "tUfLMsTl9pzXDzUX8G_LnnV6MLMxNIoAww_bXdB67vU";

// variável Open-Meteo -> chave curta no JSONB (economia de bytes)
const VARS: Record<string, string> = {
  precipitation:       "precip_mm",
  wind_gusts_10m:      "rajada_kmh",
  wind_speed_10m:      "vento_kmh",
  temperature_2m:      "temp_c",
  relative_humidity_2m:"umid_pct",
  // Cobertura de nuvem, 0-100%. Nao entra em nenhum calculo de risco: serve
  // para o painel dizer como o dia PARECE (sol, sol entre nuvens, encoberto),
  // porque um mapa so de probabilidade de chuva fica todo escuro em dia bom e
  // se confunde com ausencia de dado. Medido em 2026-09-15: as 8 linhagens
  // publicam, 48 de 48 horas validas.
  cloud_cover:         "nuvem_pct",
  // CAPE: energia convectiva. Nao e usado no calculo de hoje — o driver de
  // descarga atmosferica e a intensidade horaria de chuva, porque CAPE nao
  // existe no arquivo ERA5 e portanto nao da para calibrar retroativamente.
  // Comeca a ser guardado agora para que, em alguns meses, exista historico
  // PROPRIO de CAPE pareado com as ocorrencias da ANEEL — e ai da para testar
  // se ele bate a chuva como preditor de raio. Disponivel em 7 das 8 linhagens
  // (JMA nao publica).
  cape:                "cape",
};
const OM_VARS = Object.keys(VARS);

type Ponto    = { id: number; lat: number; lon: number };
type Linhagem = { id: number; om: string; slug: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-tempo-secret") !== SEGREDO) {
    return new Response(JSON.stringify({ erro: "nao autorizado" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const t0 = Date.now();
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let gravados = 0;
  const problemas: string[] = [];

  try {
    const { data: alvos, error: eAlvos } = await sb.rpc("tempo_alvos_coleta");
    if (eAlvos) throw eAlvos;

    const pontos: Ponto[]       = alvos.pontos ?? [];
    const linhagens: Linhagem[] = alvos.linhagens ?? [];
    if (!pontos.length || !linhagens.length) throw new Error("sem pontos ou linhagens ativas");

    // Idempotência: dentro da mesma hora, recoletar não duplica
    // (unique em ponto_id + linhagem_id + emitida_em).
    const emitida = new Date();
    emitida.setUTCMinutes(0, 0, 0);
    const emitidaISO = emitida.toISOString();

    const modelos = linhagens.map((l) => l.om).join(",");

    for (let i = 0; i < pontos.length; i += CHUNK) {
      const lote = pontos.slice(i, i + CHUNK);
      const url = `${OM}?latitude=${lote.map((p) => p.lat).join(",")}`
        + `&longitude=${lote.map((p) => p.lon).join(",")}`
        + `&hourly=${OM_VARS.join(",")}`
        + `&models=${modelos}`
        + `&forecast_days=${FORECAST_DAYS}`
        + `&timezone=UTC`;

      const resp = await fetch(url);
      if (!resp.ok) {
        problemas.push(`lote ${i}: HTTP ${resp.status} ${(await resp.text()).slice(0, 160)}`);
        continue;
      }
      const body = await resp.json();
      // Resposta multi-ponto é SEMPRE um array na MESMA ORDEM do pedido.
      // A API devolve a célula do grid, não a coordenada pedida — por isso
      // o casamento é por índice, jamais por lat/lon.
      const locais = Array.isArray(body) ? body : [body];

      const linhas: unknown[] = [];
      locais.forEach((loc: any, idx: number) => {
        const ponto = lote[idx];
        if (!ponto || !loc?.hourly?.time?.length) return;
        const tempos: string[] = loc.hourly.time;
        const inicio = tempos[0].endsWith("Z") ? tempos[0] : `${tempos[0]}Z`;

        for (const lin of linhagens) {
          const dados: Record<string, (number | null)[]> = {};
          let temAlgo = false;
          for (const [omVar, chave] of Object.entries(VARS)) {
            const serie = loc.hourly[`${omVar}_${lin.om}`];
            if (!Array.isArray(serie)) continue;
            // variável que só devolve null nesta linhagem não é armazenada —
            // antes, uma série inteira de nulls ia para o JSONB à toa.
            if (!serie.some((v: number | null) => v !== null)) continue;
            temAlgo = true;
            dados[chave] = serie;
          }
          if (!temAlgo) continue;
          linhas.push({
            ponto_id: ponto.id,
            linhagem_id: lin.id,
            emitida_em: emitidaISO,
            inicio_serie: inicio,
            passo_horas: 1,
            n_passos: tempos.length,
            dados,
          });
        }
      });

      if (linhas.length) {
        const { data: n, error: eIng } = await sb.rpc("tempo_ingerir_previsao", { p_rows: linhas });
        if (eIng) problemas.push(`lote ${i}: ingestão ${eIng.message}`);
        else gravados += (n as number) ?? 0;
      }
      if (i + CHUNK < pontos.length) await sleep(PAUSA_MS);
    }

    const ms = Date.now() - t0;
    await sb.rpc("tempo_log_coleta", {
      p_fonte: "open-meteo",
      p_ms: ms,
      p_ok: problemas.length === 0,
      p_n: gravados,
      p_erro: problemas.length ? problemas.join(" | ").slice(0, 2000) : null,
    });

    return new Response(
      JSON.stringify({ ok: problemas.length === 0, gravados, ms, problemas }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await sb.rpc("tempo_log_coleta", {
        p_fonte: "open-meteo", p_ms: ms, p_ok: false, p_n: gravados, p_erro: msg.slice(0, 2000),
      });
    } catch (_) { /* rpc() nao e Promise: .catch() nao existe */ }
    return new Response(JSON.stringify({ ok: false, erro: msg, gravados, ms }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
