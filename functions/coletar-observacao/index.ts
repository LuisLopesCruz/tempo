// ============================================================================
// TEMPO-RJ — coletor de OBSERVAÇÃO e ALERTA OFICIAL
// ----------------------------------------------------------------------------
// Camada 2 do PROJETO.md. Duas naturezas distintas, deliberadamente separadas:
//   * observação  -> CORRIGE a previsão e alimenta a verificação
//   * alerta      -> SOBREPÕE a previsão; não vota nela (princípio 5.3)
//
// DESCOBERTA OPERACIONAL (2026-09-10): ambas as fontes recusam a requisição
// sem User-Agent de navegador — a do Alerta Rio devolve "Request Rejected"
// (WAF) e a do INMET derruba a conexão. O cabeçalho abaixo não é cosmético.
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

// O valor vive num secret do Supabase, nao aqui: ate 2026-10-02 ficava em
// texto claro neste arquivo (risco R9), o que com o repositorio criado passou a
// significar segredo no historico do git — que nao se apaga. Rotacionado na
// mesma data; o valor antigo, que ficou no historico, nao serve mais.
const SEGREDO = Deno.env.get("TEMPO_SEGREDO");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CAB = { "User-Agent": UA, "Accept": "application/json,text/plain,*/*" };

const ALERTA_RIO = "http://websempre.rio.rj.gov.br/json/chuvas";
const INMET_AVISOS = "https://apiprevmet3.inmet.gov.br/avisos/ativos";

const SEVERIDADE: Record<string, string> = {
  "perigo potencial": "perigo_potencial",
  "perigo": "perigo",
  "grande perigo": "grande_perigo",
};

function evento(desc: string): string {
  const d = (desc || "").toLowerCase();
  if (d.includes("tempestade")) return "tempestade";
  if (d.includes("chuva")) return "chuva_intensa";
  if (d.includes("vento") || d.includes("vendaval")) return "vendaval";
  if (d.includes("granizo")) return "granizo";
  if (d.includes("umidade")) return "baixa_umidade";
  if (d.includes("frio") || d.includes("geada")) return "frio";
  if (d.includes("calor")) return "calor";
  return d.replace(/[^a-z]+/g, "_").slice(0, 40) || "outro";
}

// Alinhamento temporal: a precipitação horária do Open-Meteo é a soma da hora
// ANTERIOR ao timestamp. O h01 do Alerta Rio é a chuva na última hora até a
// leitura. Arredondar a leitura para a hora mais próxima põe os dois na mesma
// grade — sem isso, previsto e observado comparariam janelas defasadas.
function horaMaisProxima(iso: string): string {
  const t = new Date(iso);
  if (t.getUTCMinutes() >= 30) t.setUTCHours(t.getUTCHours() + 1);
  t.setUTCMinutes(0, 0, 0);
  return t.toISOString();
}

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

  const problemas: string[] = [];
  let nObs = 0, nAlertas = 0;

  // ------------------------------------------------- observação: Alerta Rio
  try {
    const r = await fetch(ALERTA_RIO, { headers: CAB });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const body = await r.json();
    const objetos: any[] = body?.objects ?? [];
    const linhas: unknown[] = [];

    for (const o of objetos) {
      if (o?.kind !== "pluviometric") continue;
      const loc = o.location;
      if (!Array.isArray(loc) || loc.length < 2) continue;
      const medido = horaMaisProxima(o.read_at);
      // h01 é a variável de verificação; h24 fica como contexto de saturação
      // do solo, que é o que importa para deslizamento.
      const vars: Array<[string, unknown]> = [
        ["precip_1h", o.data?.h01],
        ["precip_24h", o.data?.h24],
      ];
      for (const [nome, valor] of vars) {
        if (valor === null || valor === undefined) continue;
        linhas.push({
          fonte: "alertario",
          estacao: String(o.name).slice(0, 60),
          lat: loc[0], lon: loc[1],
          medido_em: medido,
          variavel: nome,
          valor: Number(valor),
        });
      }
    }
    if (linhas.length) {
      const { data, error } = await sb.rpc("tempo_ingerir_observacao", { p_rows: linhas });
      if (error) problemas.push("alertario ingestao: " + error.message);
      else nObs = (data as number) ?? 0;
    }
  } catch (e) {
    problemas.push("alertario: " + (e instanceof Error ? e.message : String(e)));
  }

  // --------------------------------------------------- alertas: INMET avisos
  try {
    const r = await fetch(INMET_AVISOS, { headers: CAB });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const body = await r.json();
    const avisos: any[] = [...(body?.hoje ?? []), ...(body?.futuro ?? [])];
    const linhas: unknown[] = [];

    for (const a of avisos) {
      // geocodes vem como string separada por vírgula, cobertura nacional.
      // Só interessa o que toca o RJ (IBGE 33xxxxx).
      const codes = String(a.geocodes ?? "")
        .split(/[,;\s]+/)
        .filter((c) => /^33\d{5}$/.test(c));
      if (!codes.length) continue;

      const sev = SEVERIDADE[String(a.severidade ?? "").trim().toLowerCase()] ?? "observacao";
      linhas.push({
        fonte: "inmet",
        id_externo: String(a.id ?? a.id_aviso),
        severidade: sev,
        evento: evento(a.descricao),
        inicio: new Date(String(a.inicio).replace(" ", "T") + "-03:00").toISOString(),
        fim: a.fim ? new Date(String(a.fim).replace(" ", "T") + "-03:00").toISOString() : null,
        municipios: codes,
        descricao: String(a.descricao ?? "").slice(0, 200),
        // 'riscos' costuma citar explicitamente risco de corte de energia:
        // é entrada direta para a camada de impacto.
        bruto: { riscos: a.riscos ?? null, cor: a.aviso_cor ?? null, referencia: a.referencia ?? null },
      });
    }
    if (linhas.length) {
      const { data, error } = await sb.rpc("tempo_ingerir_alerta", { p_rows: linhas });
      if (error) problemas.push("inmet ingestao: " + error.message);
      else nAlertas = (data as number) ?? 0;
    }
  } catch (e) {
    problemas.push("inmet: " + (e instanceof Error ? e.message : String(e)));
  }

  const ms = Date.now() - t0;
  // rpc() devolve um builder thenable, NAO uma Promise: nao existe .catch().
  // O log e best-effort, entao o try/catch fica explicito.
  try {
    await sb.rpc("tempo_log_coleta", {
      p_fonte: "observacao+alerta",
      p_ms: ms,
      p_ok: problemas.length === 0,
      p_n: nObs + nAlertas,
      p_erro: problemas.length ? problemas.join(" | ").slice(0, 2000) : null,
    });
  } catch (_) { /* nunca derrubar a coleta por causa do log */ }

  return new Response(
    JSON.stringify({ ok: problemas.length === 0, observacoes: nObs, alertas: nAlertas, ms, problemas }),
    { headers: { "Content-Type": "application/json" } },
  );
});
