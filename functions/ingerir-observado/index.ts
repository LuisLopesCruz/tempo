// ============================================================================
// TEMPO-RJ — porta de entrada do observado da ANEEL
// ----------------------------------------------------------------------------
// Chamada pelo GitHub Actions (.github/workflows/aneel.yml), que uma vez por dia
// espia o rodape do parquet da ANEEL e, quando o mes de competencia avanca, le
// as duas colunas que interessam e manda a contagem agregada para ca.
//
// POR QUE NAO E O ACTION QUE ESCREVE DIRETO NO BANCO
//   Escrever direto exigiria a service_role key guardada no GitHub — a chave
//   mestra do banco em mais um lugar. Aqui o GitHub guarda apenas o segredo
//   compartilhado, que nao da acesso a dado nenhum: so autoriza esta chamada.
//
// O SEGREDO VEM DO AMBIENTE, NAO DO CODIGO
//   As versoes anteriores dos coletores traziam o valor em texto claro no
//   fonte (risco R9). Com o repositorio criado em 2026-10-02, isso passou a
//   significar segredo no historico do git — que nao se apaga. Daqui em diante
//   o valor vive num secret do Supabase e entra por Deno.env.get().
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const SEGREDO = Deno.env.get("TEMPO_SEGREDO");

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

  try {
    const corpo = await req.json();
    const linhas = corpo?.rows;
    if (!Array.isArray(linhas) || !linhas.length) {
      return new Response(JSON.stringify({ erro: "rows vazio ou ausente" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    // Em lotes: um mes de RJ sao ~92 municipios x 30 dias, mas um ano inteiro
    // passa de 30 mil linhas e nao vale mandar num JSON so.
    const LOTE = 5000;
    let recebidos = 0, aceitos = 0, dias = 0;
    for (let i = 0; i < linhas.length; i += LOTE) {
      const { data, error } = await sb.rpc("tempo_ingerir_observado", {
        p_rows: linhas.slice(i, i + LOTE),
      });
      if (error) throw error;
      const r = Array.isArray(data) ? data[0] : data;
      recebidos += r?.recebidos ?? 0;
      aceitos   += r?.aceitos   ?? 0;
      dias       = r?.dias      ?? dias;
    }

    // Com observado novo, vale repontuar na hora: e o Brier da camada 3, que o
    // painel declara como "ainda nao verificado" ate existir.
    const { data: skill, error: eSkill } = await sb.rpc("impacto_pontuar");
    if (eSkill) throw eSkill;

    const ms = Date.now() - t0;
    await sb.rpc("tempo_log_coleta", {
      p_fonte: "aneel-observado", p_ms: ms, p_ok: true, p_n: aceitos, p_erro: null,
    });

    return new Response(JSON.stringify({ ok: true, recebidos, aceitos, dias, skill, ms }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await sb.rpc("tempo_log_coleta", {
        p_fonte: "aneel-observado", p_ms: ms, p_ok: false, p_n: 0, p_erro: msg.slice(0, 2000),
      });
    } catch (_) { /* rpc() nao e Promise: .catch() nao existe */ }
    return new Response(JSON.stringify({ ok: false, erro: msg, ms }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
