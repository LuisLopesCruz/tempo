// ============================================================================
// TEMPO-RJ — coletor de OBSERVAÇÃO, ALERTA OFICIAL e RISCO DA DEFESA CIVIL
// ----------------------------------------------------------------------------
// Camada 2 do PROJETO.md. Três naturezas distintas, deliberadamente separadas:
//   * observação  -> CORRIGE a previsão e alimenta a verificação
//   * alerta      -> SOBREPÕE a previsão; não vota nela (princípio 5.3)
//   * risco       -> ESTADO do município (solo/hidrologia), não evento
//
// Por que o risco entra aqui e não numa função nova: ele é mais uma leitura
// horária de fonte externa, igual às outras duas. Função própria exigiria
// outro cron, outro segredo e outro deploy — mais processo do que o problema
// merece.
//
// DESCOBERTA OPERACIONAL (2026-09-10): ambas as fontes recusam a requisição
// sem User-Agent de navegador — a do Alerta Rio devolve "Request Rejected"
// (WAF) e a do INMET derruba a conexão. O cabeçalho abaixo não é cosmético.
//
// verify_jwt FICA EM false DE PROPOSITO: quem chama e o pg_cron via pg_net,
// que manda o cabecalho x-tempo-secret e nao um JWT. A autenticacao propria
// esta no corpo da funcao, logo abaixo. Ligar verify_jwt derruba a coleta
// inteira com 401 — aconteceu no deploy da v7, em 2026-10-03.
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

// Painel do CEMADEN-RJ, da Defesa Civil estadual. NÃO é API: é HTML renderado
// no servidor, e por isso frágil — se mudarem o layout, o parse devolve zero
// linhas. A trava MIN_MUNICIPIOS existe exatamente para isso: melhor falhar
// alto e aparecer no coleta_log do que gravar vazio em silêncio.
const CEMADEN_RJ = "https://painelcemadenrj.defesacivil.rj.gov.br/monitoramento/v2/municipio/";
const RISCOS: Array<[string, string]> = [["geo", "geologico"], ["hidro", "hidrologico"]];
const MIN_MUNICIPIOS = 85;   // são 92; abaixo disto o parse quebrou

// O painel é UTF-8 (meta charset), não latin-1. Ler errado corrompe justamente
// os nomes acentuados — MACAÉ, PETRÓPOLIS, NITERÓI — e o casamento com o IBGE
// falharia em 30 dos 92 municípios sem erro nenhum aparecer.
// A legenda oficial do painel publica CINCO niveis, numerados de 1 a 5 — e o
// numero vem na coluna Prioridade de cada linha:
//   1 MUITO BAIXO | 2 BAIXO | 3 MODERADO | 4 ALTO | 5 MUITO ALTO
// "MUITO BAIXO" faltava aqui na primeira versao: ele cairia em 'desconhecido'
// e o painel, que mostra desconhecido em vermelho no topo, exibiria o nivel
// MAIS BRANDO como se fosse o mais grave.
const NIVEL_RISCO: Record<string, string> = {
  "MUITO BAIXO": "muito_baixo",
  "BAIXO": "baixo",
  "MODERADO": "moderado",
  "ALTO": "alto",
  "MUITO ALTO": "muito_alto",
};

// O INMET publica hoje tres niveis, mas com id_severidade 6, 7 e 8 — a
// numeracao comecar em 6 diz que a tabela deles tem (ou teve) outros. Nada
// garante que um 9 nao apareca.
const SEVERIDADE: Record<string, string> = {
  "perigo potencial": "perigo_potencial",
  "perigo": "perigo",
  "grande perigo": "grande_perigo",
};

// Lê a tabela do painel. Cada <tr> traz: municipio | REDEC | nivel |
// ultima atualizacao | historico | prioridade. O cabeçalho usa <th>, então
// filtrar por <td> já o descarta sozinho.
function lerRisco(html: string, tipo: string): Record<string, unknown>[] {
  const linhas: Record<string, unknown>[] = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const td = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      .filter((x) => x.length > 0);
    if (td.length < 4) continue;

    // "03/10/2026 06:53:41" em horário de Brasília. O -03:00 é fixo pela mesma
    // razão que no alerta do INMET: o Brasil não tem horário de verão hoje.
    const d = td[3].match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!d) continue;

    const bruto = td[2].toUpperCase();
    linhas.push({
      municipio: td[0],
      tipo,
      // Nível fora do mapa vira 'desconhecido', nunca o mais brando: mesma
      // lição da severidade do INMET. A palavra original vai junto.
      nivel: NIVEL_RISCO[bruto] ?? "desconhecido",
      nivel_fonte: td[2],
      prioridade: td.length > 4 ? td[4] : null,
      atualizado_fonte: `${d[3]}-${d[2]}-${d[1]}T${d[4]}:${d[5]}:${d[6]}-03:00`,
    });
  }
  return linhas;
}

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
  let nObs = 0, nAlertas = 0, nRisco = 0;

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

      // NUNCA rebaixar para 'observacao' o que nao esta no mapa: isso tornava
      // um nivel novo — possivelmente mais grave — no mais brando de todos,
      // em silencio, e apagava a palavra original. Vai para 'desconhecida',
      // que o painel ordena no topo e pinta com a cor que o INMET mandou.
      const sevBruta = String(a.severidade ?? "").trim();
      const sev = SEVERIDADE[sevBruta.toLowerCase()] ?? "desconhecida";
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
        bruto: {
          riscos: a.riscos ?? null,
          cor: a.aviso_cor ?? null,
          referencia: a.referencia ?? null,
          // guardado SEMPRE, nao so quando desconhecido: se amanha o INMET
          // renomear um nivel que hoje mapeamos, da para descobrir olhando.
          severidade_bruta: sevBruta || null,
        },
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

  // ------------------------------------- risco oficial: CEMADEN-RJ / Defesa Civil
  // Lê AO VIVO as duas listas toda hora. A fonte só se atualiza uma punhada de
  // vezes por dia, mas quem decide o que é foto nova é o carimbo dela: a chave
  // única (municipio, tipo, atualizado_fonte) faz o banco recusar a repetida.
  for (const [acao, tipo] of RISCOS) {
    try {
      const r = await fetch(CEMADEN_RJ + "?action=" + acao, { headers: CAB });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const linhas = lerRisco(await r.text(), tipo);
      if (linhas.length < MIN_MUNICIPIOS) {
        throw new Error(`parse devolveu ${linhas.length} municipios, esperado >= ${MIN_MUNICIPIOS}`);
      }
      const { data, error } = await sb.rpc("tempo_ingerir_risco", { p_rows: linhas });
      if (error) problemas.push(`risco ${tipo} ingestao: ` + error.message);
      else nRisco += (data as number) ?? 0;
    } catch (e) {
      problemas.push(`risco ${tipo}: ` + (e instanceof Error ? e.message : String(e)));
    }
  }

  const ms = Date.now() - t0;
  // rpc() devolve um builder thenable, NAO uma Promise: nao existe .catch().
  // O log e best-effort, entao o try/catch fica explicito.
  try {
    await sb.rpc("tempo_log_coleta", {
      p_fonte: "observacao+alerta",
      p_ms: ms,
      p_ok: problemas.length === 0,
      p_n: nObs + nAlertas + nRisco,
      p_erro: problemas.length ? problemas.join(" | ").slice(0, 2000) : null,
    });
  } catch (_) { /* nunca derrubar a coleta por causa do log */ }

  return new Response(
    JSON.stringify({ ok: problemas.length === 0, observacoes: nObs, alertas: nAlertas,
                     risco: nRisco, ms, problemas }),
    { headers: { "Content-Type": "application/json" } },
  );
});
