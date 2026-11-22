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

// Segunda tentativa dos lotes que falharem. O 503 "The service is overloaded"
// da Open-Meteo e passageiro: em 10 dias (05-15/10) custou 1 ciclo inteiro e 2
// parciais, porque nao havia nova tentativa. Uma rodada so, depois de uma
// pausa, e so enquanto houver folga para terminar antes do limite de 150 s da
// Edge Function: passar dele mata a execucao SEM gravar log (08/10 06h nao
// deixou rastro), o que e pior do que perder o lote.
const PAUSA_RETRY_MS  = 15_000;
const LIMITE_RETRY_MS = 105_000;   // depois disto nao comeca nova tentativa

// Prazo de cada requisicao. Sem ele, um lote que a Open-Meteo aceita e nao
// responde segura a execucao ate os 150 s e ela morre sem log: 15, 16 e 17/10
// 00h (0 de 736) e 17/10 12h (160 de 736), todas com CPU < 70 ms — so espera.
// Um lote normal leva 2-20 s. Com prazo, o lote preso vira falha comum, vai
// para a segunda tentativa e o log sai sempre. PRAZO_MS e o teto absoluto
// de qualquer busca, deixando folga para gravar e registrar o log.
const TIMEOUT_LOTE_MS = 30_000;
const PRAZO_MS        = 135_000;

// O valor vive num secret do Supabase, nao aqui: ate 2026-10-02 ficava em
// texto claro neste arquivo (risco R9), o que com o repositorio criado passou a
// significar segredo no historico do git — que nao se apaga. Rotacionado na
// mesma data; o valor antigo, que ficou no historico, nao serve mais.
const SEGREDO = Deno.env.get("TEMPO_SEGREDO");

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
// Nuvem VISIVEL (22/11/2026): o maior entre nuvem baixa e media. A cobertura
// total (cloud_cover) soma as nuvens altas — cirros finos que nao escondem o
// sol — e quatro dos oito modelos as espalham pelo ceu inteiro: em 22/11,
// com ceu azul e METAR "FEW" em Sao Pedro da Aldeia, a mediana total dava
// 81-96% e o painel nunca desenhava sol. Baixa e media sao buscadas mas NAO
// gravadas: so o maximo das duas vai para o blob (o banco esta perto dos
// 500 MB do plano gratuito; uma serie a mais custa ~1/7 do tamanho do blob).
const NUVEM_CAMADAS = ["cloud_cover_low", "cloud_cover_mid"];
const OM_VARS = [...Object.keys(VARS), ...NUVEM_CAMADAS];

type Ponto    = { id: number; lat: number; lon: number };
type Linhagem = { id: number; om: string; slug: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req: Request) => {
  if (!SEGREDO) {
    return new Response(JSON.stringify({ erro: "TEMPO_SEGREDO nao configurado" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
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

    // Busca e monta UM lote. Lanca erro em falha de rede, HTTP ou JSON — quem
    // chama decide. Antes isso ficava solto no laco: um JSON truncado escapava
    // para o catch de fora e matava a coleta INTEIRA (13/10 12h: 0 de 736).
    const buscarLote = async (lote: Ponto[]): Promise<unknown[]> => {
      const url = `${OM}?latitude=${lote.map((p) => p.lat).join(",")}`
        + `&longitude=${lote.map((p) => p.lon).join(",")}`
        + `&hourly=${OM_VARS.join(",")}`
        + `&models=${modelos}`
        + `&forecast_days=${FORECAST_DAYS}`
        + `&timezone=UTC`;

      const folga = PRAZO_MS - (Date.now() - t0);
      if (folga < 5_000) throw new Error("sem folga no prazo da execucao");
      // O sinal cobre tambem a leitura do corpo (resp.json()), nao so a conexao.
      const resp = await fetch(url, { signal: AbortSignal.timeout(Math.min(TIMEOUT_LOTE_MS, folga)) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${(await resp.text()).slice(0, 160)}`);
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
          const baixa = loc.hourly[`cloud_cover_low_${lin.om}`];
          const media = loc.hourly[`cloud_cover_mid_${lin.om}`];
          if (Array.isArray(baixa) || Array.isArray(media)) {
            const vis = tempos.map((_, i) => {
              const b = Array.isArray(baixa) ? baixa[i] : null, m = Array.isArray(media) ? media[i] : null;
              return b == null && m == null ? null : Math.max(b ?? 0, m ?? 0);
            });
            if (vis.some((v) => v !== null)) dados.nuvem_vis = vis;
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

      return linhas;
    };

    // Gravar NAO entra na segunda tentativa: erro de ingestao e do nosso banco,
    // e buscar de novo na Open-Meteo nao o resolveria.
    const gravar = async (i: number, linhas: unknown[]) => {
      if (!linhas.length) return;
      const { data: n, error: eIng } = await sb.rpc("tempo_ingerir_previsao", { p_rows: linhas });
      if (eIng) problemas.push(`lote ${i}: ingestão ${eIng.message}`);
      else gravados += (n as number) ?? 0;
    };
    const msgDe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

    // Primeira passada: cada lote isolado; o que falhar fica anotado.
    const falhos = new Map<number, string>();
    for (let i = 0; i < pontos.length; i += CHUNK) {
      try {
        await gravar(i, await buscarLote(pontos.slice(i, i + CHUNK)));
      } catch (e) {
        falhos.set(i, msgDe(e));
      }
      if (i + CHUNK < pontos.length) await sleep(PAUSA_MS);
    }

    // Segunda tentativa, com prazo.
    const recuperados: string[] = [];
    if (falhos.size) {
      await sleep(PAUSA_RETRY_MS);
      for (const [i, erro1] of falhos) {
        if (Date.now() - t0 > LIMITE_RETRY_MS) {
          problemas.push(`lote ${i}: ${erro1} (sem folga para 2a tentativa)`);
          continue;
        }
        try {
          await gravar(i, await buscarLote(pontos.slice(i, i + CHUNK)));
          recuperados.push(`lote ${i} (${erro1.slice(0, 40)})`);
        } catch (e) {
          problemas.push(`lote ${i}: ${erro1} | 2a tentativa: ${msgDe(e)}`);
        }
      }
    }

    const ms = Date.now() - t0;
    // Lote recuperado nao e falha: a coleta saiu completa. Mas fica anotado no
    // log, para dar para medir com que frequencia a segunda tentativa salva.
    const nota = problemas.length ? problemas.join(" | ")
               : recuperados.length ? "recuperado na 2a tentativa: " + recuperados.join(", ")
               : null;
    await sb.rpc("tempo_log_coleta", {
      p_fonte: "open-meteo",
      p_ms: ms,
      p_ok: problemas.length === 0,
      p_n: gravados,
      p_erro: nota ? nota.slice(0, 2000) : null,
    });

    return new Response(
      JSON.stringify({ ok: problemas.length === 0, gravados, ms, problemas, recuperados }),
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
