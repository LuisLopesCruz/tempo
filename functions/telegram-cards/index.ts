// ============================================================================
// TEMPO-RJ — TESTE dos cards em imagem no Telegram (pedido do usuario, 13/11)
// ----------------------------------------------------------------------------
// Manda os 11 tipos de mensagem do bot, em imagem, SO para o administrador.
// Nao mexe no bot (tempo-telegram) nem em nenhum inscrito: e para aprovar o
// visual antes de trocar o formato de verdade.
//   ?tipo=1  boletim da regiao (dados reais, Regiao dos Lagos)
//   ?tipo=2  boletim do municipio (dados reais, Sao Pedro da Aldeia)
//   ?tipo=3..11  os 9 avisos imediatos, com exemplo ficticio marcado TESTE
//   &cadeia=1  depois de mandar um, chama o proximo (cada card na sua propria
//              execucao: o limite de CPU do Supabase e por chamada)
//
// Desenho: satori (arvore -> SVG) + resvg (SVG -> PNG), tudo em WebAssembly,
// fonte Inter baixada do jsDelivr. Custo zero.
// verify_jwt FICA EM false; autentica por x-tempo-secret, como os coletores.
// ============================================================================
import satori from "npm:satori@0.12.2";
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cardAviso, cardBoletimMunicipio, cardBoletimRegiao, exemplos, W } from "./cards.ts";

const TOKEN = Deno.env.get("TELEGRAM_TOKEN");
const SEGREDO = Deno.env.get("TEMPO_SEGREDO");
const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(URL_BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

let pronto: Promise<{ name: string; data: ArrayBuffer; weight: number; style: "normal" }[]> | null = null;
function preparar() {
  if (!pronto) pronto = (async () => {
    await initWasm(fetch("https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm"));
    return await Promise.all([400, 600, 700, 800].map(async (w) => ({
      name: "Inter", weight: w, style: "normal" as const,
      data: await (await fetch(`https://cdn.jsdelivr.net/npm/@fontsource/inter@5.1.0/files/inter-latin-${w}-normal.woff`)).arrayBuffer(),
    })));
  })();
  return pronto;
}
async function png(card: { no: unknown; altura: number }): Promise<Uint8Array> {
  const fonts = await preparar();
  const svg = await satori(card.no as any, { width: W, height: card.altura, fonts });
  return new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng();
}
async function rpc(nome: string, args: Record<string, unknown> = {}) {
  const { data, error } = await sb.rpc(nome, args);
  if (error) throw new Error(`${nome}: ${error.message}`);
  return data;
}

Deno.serve(async (req: Request) => {
  if (!TOKEN || !SEGREDO) return json({ erro: "segredos ausentes" }, 500);
  if (req.headers.get("x-tempo-secret") !== SEGREDO) return json({ erro: "nao autorizado" }, 401);
  const u = new URL(req.url);
  const tipo = Number(u.searchParams.get("tipo") ?? "1");
  const cadeia = u.searchParams.get("cadeia") === "1";
  const t0 = Date.now();
  try {
    const admin = ((await rpc("tempo_tg_admins")) as number[])[0];
    const agora = new Date(Date.now() - 3 * 3_600_000);
    const hh = String(agora.getUTCHours()).padStart(2, "0"), mi = String(agora.getUTCMinutes()).padStart(2, "0");
    const quando = `${String(agora.getUTCDate()).padStart(2, "0")}/${String(agora.getUTCMonth() + 1).padStart(2, "0")} ${hh}h${mi}`;

    let card: { no: unknown; altura: number }, nome: string;
    if (tipo === 1) {
      const regs = (await rpc("tempo_tg_boletim")) as any[];
      card = cardBoletimRegiao(regs.find((r) => r.regiao === "Região dos Lagos"), `${hh}h${mi}`, quando);
      nome = "Boletim da região";
    } else if (tipo === 2) {
      card = cardBoletimMunicipio(await rpc("tempo_tg_municipio", { p_ibge: 3305208 }), quando);
      nome = "Boletim do município (/boletim)";
    } else {
      const ex = exemplos(quando)[tipo - 3];
      if (!ex) return json({ erro: "tipo invalido" }, 400);
      card = cardAviso(ex.aviso);
      nome = ex.nome;
    }
    const imagem = await png(card);

    const fd = new FormData();
    fd.append("chat_id", String(admin));
    fd.append("parse_mode", "HTML");
    fd.append("caption", `<b>Teste ${tipo}/11 · ${nome}</b>\n` +
      (tipo <= 2 ? "Dados reais de agora." : "Exemplo fictício, só para ver o visual."));
    if (tipo > 1) fd.append("disable_notification", "true");
    fd.append("photo", new Blob([imagem], { type: "image/png" }), `tempo-rj-${tipo}.png`);
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: fd });
    const j = await r.json();
    await rpc("tempo_tg_log", { p_chat: admin, p_tipo: "teste_card", p_regiao: nome, p_ok: !!j.ok,
                                p_erro: j.ok ? null : String(j.description ?? r.status).slice(0, 300) });
    if (!j.ok) throw new Error("sendPhoto: " + j.description);

    if (cadeia && tipo < 11) {
      const prox = fetch(`${URL_BASE}/functions/v1/tempo-telegram-cards?tipo=${tipo + 1}&cadeia=1`,
                         { method: "POST", headers: { "x-tempo-secret": SEGREDO } }).catch(() => {});
      // deixa o proximo comecar sem segurar esta execucao
      (globalThis as any).EdgeRuntime?.waitUntil?.(prox);
    }
    return json({ ok: true, tipo, nome, altura: card.altura, kb: Math.round(imagem.length / 1024), ms: Date.now() - t0 });
  } catch (e) {
    return json({ ok: false, tipo, erro: e instanceof Error ? e.message : String(e) }, 500);
  }
});
