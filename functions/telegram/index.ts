// ============================================================================
// TEMPO-RJ — bot do Telegram (@TempoRJ_bot)
// ----------------------------------------------------------------------------
// Tres entradas na MESMA funcao:
//   POST do Telegram (webhook)       -> conversa: /start, /regioes, /parar, /ajuda
//                                      e os botoes. Autentica pelo cabecalho
//                                      X-Telegram-Bot-Api-Secret-Token.
//   POST do pg_cron ?acao=avisos     -> avisos imediatos: trovoada + INMET, Defesa Civil,
//                                      risco eletrico e chuva forte medida (a cada 6 min)
//   POST do pg_cron ?acao=boletim    -> boletim das 06h, 12h, 18h e 00h (Brasilia)
//   POST manual    ?acao=configurar  -> registra webhook e menu no Telegram (1 vez)
// As duas ultimas autenticam por x-tempo-secret, como os coletores.
//
// verify_jwt FICA EM false: nem o Telegram nem o pg_cron mandam JWT. Ligar
// derruba tudo com 401 (licao da v7 do coletor de observacao, 03/10/2026).
//
// O TOKEN do bot vive no secret TELEGRAM_TOKEN do Supabase, cadastrado pelo
// usuario. Nunca no codigo, nunca no git, nunca no chat.
// O segredo do webhook e DERIVADO do TEMPO_SEGREDO (sha-256): nao ha segredo
// novo para guardar, e o formato hexadecimal e o que o Telegram aceita.
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import satori from "npm:satori@0.12.2";
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import * as K from "./cards.ts";

const TOKEN = Deno.env.get("TELEGRAM_TOKEN");
const SEGREDO = Deno.env.get("TEMPO_SEGREDO");
const API = `https://api.telegram.org/bot${TOKEN}`;

// As 11 regioes do painel, na ordem do mapa (capital, metropole, litoral, interior).
const REGIOES = ["Capital", "Baixada Fluminense", "Leste Metropolitano", "Região dos Lagos",
  "Costa do Sol", "Costa Verde", "Médio Paraíba", "Centro-Sul", "Serrana", "Norte", "Noroeste"];

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Hora de Brasilia, fixa em -03:00 (o Brasil nao tem horario de verao hoje).
function hm(iso: string): string {
  const t = new Date(new Date(iso).getTime() - 3 * 3_600_000);
  return String(t.getUTCHours()).padStart(2, "0") + "h" + String(t.getUTCMinutes()).padStart(2, "0");
}

async function tg(metodo: string, corpo: Record<string, unknown>) {
  const r = await fetch(`${API}/${metodo}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo), signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({ ok: false, description: "resposta invalida" }));
  if (!j.ok) throw new Error(`${metodo}: ${j.description ?? r.status}`);
  return j.result;
}
// Se o Telegram recusar a formatacao (HTML mal formado), a mensagem sai SEM
// formatacao em vez de se perder: aviso feio chega; aviso perdido nao.
async function enviar(chat: number, texto: string, extra: Record<string, unknown> = {}) {
  try {
    return await tg("sendMessage", { chat_id: chat, text: texto, parse_mode: "HTML",
                                     disable_web_page_preview: true, ...extra });
  } catch (e) {
    if (!/can't parse entities/i.test(e instanceof Error ? e.message : String(e))) throw e;
    const puro = texto.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return await tg("sendMessage", { chat_id: chat, text: puro, disable_web_page_preview: true, ...extra });
  }
}

// ------------------------------------------------------------ cards em IMAGEM (aprovados em 13/11)
// Toda mensagem do bot sai como foto (cards.ts desenha) com legenda curta. O
// texto de antes fica de RESERVA: se a imagem falhar, a pessoa recebe o texto.
// O Supabase limita a CPU por chamada; entao cada execucao desenha no maximo
// MAX_IMAGENS e passa o resto da fila para uma nova execucao (?acao=fila), em
// ordem. Uma imagem serve a todos os destinatarios (file_id do Telegram).
const MAX_IMAGENS = 2;
let prontoImg: Promise<{ name: string; data: ArrayBuffer; weight: number; style: "normal" }[]> | null = null;
function prepararImg() {
  if (!prontoImg) prontoImg = (async () => {
    await initWasm(fetch("https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm"));
    return await Promise.all([400, 600, 700, 800].map(async (w) => ({
      name: "Inter", weight: w, style: "normal" as const,
      data: await (await fetch(`https://cdn.jsdelivr.net/npm/@fontsource/inter@5.1.0/files/inter-latin-${w}-normal.woff`)).arrayBuffer(),
    })));
  })().catch((e) => { prontoImg = null; throw e; });
  return prontoImg;
}
async function png(card: { no: unknown; altura: number }): Promise<Uint8Array> {
  const fonts = await prepararImg();
  const svg = await satori(card.no as any, { width: K.W, height: card.altura, fonts });
  return new Resvg(svg, { fitTo: { mode: "width", value: K.W } }).render().asPng();
}

type Destino = { chat: number; silencioso: boolean };
type CardSpec = { k: "aviso"; a: K.Aviso } | { k: "regiao"; r: any; rotulo: string; quando: string }
              | { k: "mun"; m: any; dias: K.Dia[]; quando: string };
type Job = { tipo: string; regiao: string | null; card: CardSpec; legenda: string; texto: string; destinos: Destino[] };

function montarCard(c: CardSpec) {
  return c.k === "aviso" ? K.cardAviso(c.a)
       : c.k === "regiao" ? K.cardBoletimRegiao(c.r, c.rotulo, c.quando)
       : K.cardBoletimMunicipio(c.m, c.quando, c.dias);
}
async function foto(chat: number, src: Uint8Array | string, legenda: string, silencioso: boolean, html = true): Promise<any> {
  const fd = new FormData();
  fd.append("chat_id", String(chat));
  fd.append("caption", legenda);
  if (html) fd.append("parse_mode", "HTML");
  if (silencioso) fd.append("disable_notification", "true");
  if (typeof src === "string") fd.append("photo", src);
  else fd.append("photo", new Blob([src], { type: "image/png" }), "tempo-rj.png");
  const r = await fetch(`${API}/sendPhoto`, { method: "POST", body: fd, signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({ ok: false, description: "resposta invalida" }));
  if (!j.ok) {
    if (html && /can't parse entities/i.test(j.description ?? ""))
      return foto(chat, src, legenda.replace(/<[^>]*>/g, ""), silencioso, false);
    throw new Error(`sendPhoto: ${j.description ?? r.status}`);
  }
  return j.result;
}
// Quem recebe varias mensagens na mesma rodada ouve UM toque: so a primeira toca.
function umToque(jobs: Job[]) {
  const tocou = new Set<number>();
  for (const j of jobs) for (const d of j.destinos) {
    if (d.silencioso) continue;
    if (tocou.has(d.chat)) d.silencioso = true; else tocou.add(d.chat);
  }
}
function encadear(jobs: Job[]) {
  const p = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/tempo-telegram?acao=fila`, {
    method: "POST", headers: { "x-tempo-secret": SEGREDO!, "Content-Type": "application/json" },
    body: JSON.stringify({ jobs }),
  }).catch(() => {});
  (globalThis as any).EdgeRuntime?.waitUntil?.(p);
}
async function processar(jobs: Job[]): Promise<number> {
  let enviados = 0, feitas = 0;
  while (jobs.length) {
    if (feitas >= MAX_IMAGENS) { encadear(jobs); break; }
    const j = jobs.shift()!;
    let imagem: Uint8Array | null = null;
    try { imagem = await png(montarCard(j.card)); } catch (e) { console.error("card", j.tipo, e instanceof Error ? e.message : e); }
    feitas++;
    let fileId: string | null = null;
    for (const d of j.destinos) {
      try {
        if (imagem) {
          try {
            const r = await foto(d.chat, fileId ?? imagem, j.legenda, d.silencioso);
            fileId ??= r?.photo?.[r.photo.length - 1]?.file_id ?? null;
          } catch (e) {
            if (/blocked|deactivated|chat not found/i.test(String(e))) throw e;
            await enviar(d.chat, j.texto, { disable_notification: d.silencioso });   // reserva: o texto
          }
        } else {
          await enviar(d.chat, j.texto, { disable_notification: d.silencioso });
        }
        enviados++;
        await rpc("tempo_tg_log", { p_chat: d.chat, p_tipo: j.tipo, p_regiao: j.regiao, p_ok: true, p_erro: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await rpc("tempo_tg_log", { p_chat: d.chat, p_tipo: j.tipo, p_regiao: j.regiao, p_ok: false, p_erro: msg.slice(0, 300) });
        if (/blocked|deactivated|chat not found/i.test(msg)) await rpc("tempo_tg_status", { p_chat: d.chat, p_status: "parado" });
      }
    }
  }
  return enviados;
}
const EMOJI: Record<string, string> = { raio: "⚡", check: "✅", tomada: "🔌", alerta: "⚠️", montanha: "🏔️", onda: "🌊", chuva: "🌧️" };
function legendaAviso(a: K.Aviso, regiao: string): string {
  return `<b>${EMOJI[a.icone] ?? ""} ${esc(a.titulo)} · ${esc(regiao)}</b>` + (a.resumo ? "\n" + esc(a.resumo) : "");
}
function agoraTxt(): string {
  const t = new Date(Date.now() - 3 * 3_600_000);
  return `${String(t.getUTCDate()).padStart(2, "0")}/${String(t.getUTCMonth() + 1).padStart(2, "0")} ` +
         `${String(t.getUTCHours()).padStart(2, "0")}h${String(t.getUTCMinutes()).padStart(2, "0")}`;
}

async function segredoWebhook(): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("telegram:" + SEGREDO));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rpc(nome: string, args: Record<string, unknown> = {}) {
  const { data, error } = await sb.rpc(nome, args);
  if (error) throw new Error(`${nome}: ${error.message}`);
  return data;
}

// ------------------------------------------------------------ painel fixado no topo
// Pedido do usuario (08/11): o endereco do site no TOPO do bot, e os avisos
// explicativos o bastante para so abrir o site quem quiser ver mais. A
// mensagem fixada fica sempre visivel no alto da conversa.
const SITE = "https://tempo-rj.vercel.app";
async function fixarPainel(chat: number) {
  const msg = await enviar(chat, `🌐 <b>Painel completo do TEMPO-RJ</b>
${SITE}
` +
    "Mapas, gráficos e os 92 municípios. Os avisos aqui já trazem o essencial — " +
    "o painel é para quem quiser ver mais.", { disable_notification: true });
  await tg("pinChatMessage", { chat_id: chat, message_id: msg.message_id, disable_notification: true });
}

// ------------------------------------------------------------ menu de regioes
function teclado(regioes: string[], todas: boolean) {
  const marca = (on: boolean) => (on ? "✅ " : "▫️ ");
  const linhas: { text: string; callback_data: string }[][] = [
    [{ text: marca(todas) + "Todas as regiões", callback_data: "t:all" }],
  ];
  for (let i = 0; i < REGIOES.length; i += 2) {
    linhas.push(REGIOES.slice(i, i + 2).map((r, k) => ({
      text: marca(todas || regioes.includes(r)) + r, callback_data: "t:" + (i + k),
    })));
  }
  linhas.push([{ text: "Concluir", callback_data: "fim" }]);
  return { inline_keyboard: linhas };
}

function resumoRegioes(u: { regioes: string[]; todas: boolean }) {
  if (u.todas) return "todas as regiões";
  if (!u.regioes.length) return "nenhuma região (você não vai receber avisos)";
  return u.regioes.join(", ");
}

const AJUDA =
  "<b>TEMPO-RJ</b> · avisos de tempo para o estado do Rio\n\n" +
  "/boletim — boletim agora: de um município ou das suas regiões\n" +
  "/boletim Petrópolis — direto para um município\n" +
  "/ouvi São Pedro da Aldeia — ouviu trovoada? Conte onde: o relato ensina o aviso\n" +
  "/regioes — escolher as regiões que você acompanha\n" +
  "/parar — parar de receber avisos\n" +
  "/start — voltar a receber\n" +
  "/ajuda — esta mensagem\n\n" +
  "<b>Boletim</b> às 06h, 12h, 18h e 00h (este sem som): chance de chuva, acumulado, rajada, " +
  "risco elétrico e alertas oficiais, com os mesmos números do painel.\n" +
  "<b>Aviso imediato</b> (a qualquer hora, quando começa ou piora): trovoada a até 30 km do " +
  "seu município, com a chance de chegar (descargas da REDEMET, a cada 6 min; a chance é aprendida " +
  "conferindo cada aviso 2 h depois), alerta laranja ou vermelho do INMET, " +
  "risco alto da Defesa Civil, risco elétrico alto e chuva forte medida nos pluviômetros.";

// ------------------------------------------------------------ conversa
async function conversa(upd: any) {
  if (upd.callback_query) return botao(upd.callback_query);
  const m = upd.message;
  if (!m?.chat || m.chat.type !== "private") return;     // so conversa particular
  const chat = m.chat.id;
  const texto = String(m.text ?? "").trim();
  const nome = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ");
  const cmd = texto.split(/[\s@]/)[0].toLowerCase();

  if (cmd === "/start") {
    const u = await rpc("tempo_tg_start", { p_chat: chat, p_nome: nome, p_usuario: m.from?.username ?? null });
    if (u.status === "pendente") {
      await enviar(chat, "Olá! Seu pedido de acesso ao <b>TEMPO-RJ</b> foi enviado ao administrador. " +
                         "Você recebe uma mensagem aqui quando for aprovado.");
      if (u.novo) {
        for (const adm of (await rpc("tempo_tg_admins")) as number[]) {
          await enviar(adm, `🔔 Pedido de acesso: <b>${esc(nome)}</b>` +
            (m.from?.username ? ` (@${esc(m.from.username)})` : ""), {
            reply_markup: { inline_keyboard: [[
              { text: "✅ Aprovar", callback_data: "ap:" + chat },
              { text: "✖️ Recusar", callback_data: "rc:" + chat }]] },
          });
        }
      }
      return;
    }
    if (u.status === "recusado") return;                  // silencio: nao insiste
    if (u.novo) await fixarPainel(chat).catch(() => {});
    await enviar(chat, (u.admin && u.novo
      ? "Olá! Você é o <b>administrador</b> do TEMPO-RJ: pedidos de acesso chegam aqui para você aprovar.\n\n"
      : "Olá! Bem-vindo ao <b>TEMPO-RJ</b>.\n\n") +
      "Escolha as regiões que quer acompanhar e toque em <b>Concluir</b>:",
      { reply_markup: teclado(u.regioes, u.todas) });
    return;
  }

  const u = await rpc("tempo_tg_get", { p_chat: chat });
  if (!u || u.status === "recusado") return;
  if (u.status === "pendente") {
    await enviar(chat, "Seu acesso ainda está aguardando aprovação.");
    return;
  }
  if (cmd === "/regioes") {
    await enviar(chat, "Toque para marcar ou desmarcar, depois em <b>Concluir</b>:",
                 { reply_markup: teclado(u.regioes, u.todas) });
  } else if (cmd === "/boletim") {
    // "/boletim Petropolis" vai direto; "/boletim" sozinho pergunta o que a pessoa quer
    const termo = texto.replace(/^\/boletim(@\w+)?/i, "").trim();
    if (termo) await buscarMunicipio(chat, termo);
    else await enviar(chat, "Boletim de quê?", { reply_markup: MENU_BOLETIM });
  } else if (cmd === "/ouvi") {
    // "/ouvi Sao Pedro da Aldeia" registra direto; "/ouvi" sozinho pergunta onde
    const termo = texto.replace(/^\/ouvi(@\w+)?/i, "").trim();
    if (!termo) {
      await enviar(chat, "🔊 Onde você ouviu trovoada? Escolha a <b>região</b>:", { reply_markup: tecladoRegioesMun("o") });
      return;
    }
    const achados = acharMunicipios((await rpc("tempo_tg_municipios")) as MunInfo[], termo);
    if (achados.length === 1) await relatar(chat, achados[0].ibge, u);
    else if (achados.length > 1 && achados.length <= 12) {
      await enviar(chat, `Encontrei ${achados.length} municípios. Onde foi?`, { reply_markup: tecladoMunicipios(achados, "o") });
    } else {
      await enviar(chat, `Não encontrei "${esc(termo)}". Escolha a região:`, { reply_markup: tecladoRegioesMun("o") });
    }
  } else if (cmd === "/parar") {
    await rpc("tempo_tg_status", { p_chat: chat, p_status: "parado" });
    await enviar(chat, "Pronto, você não recebe mais avisos. Para voltar, mande /start.");
  } else {
    await enviar(chat, AJUDA);
  }
}

async function botao(q: any) {
  const chat = q.message?.chat?.id;
  const d = String(q.data ?? "");
  const resp = (texto?: string) => tg("answerCallbackQuery", { callback_query_id: q.id, text: texto });
  const u = await rpc("tempo_tg_get", { p_chat: chat });
  if (!u || u.status !== "ativo") { await resp("Acesso não liberado."); return; }

  if (d.startsWith("b:")) return botaoBoletim(q, chat, d, u);
  if (d.startsWith("o:")) return botaoOuvi(q, chat, d, u);

  if (d.startsWith("ap:") || d.startsWith("rc:")) {
    if (!u.admin) { await resp("Só o administrador aprova."); return; }
    const alvo = Number(d.slice(3));
    const ok = d.startsWith("ap:");
    const r = await rpc("tempo_tg_status", { p_chat: alvo, p_status: ok ? "ativo" : "recusado" });
    await resp(ok ? "Aprovado" : "Recusado");
    await tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, parse_mode: "HTML",
      text: (ok ? "✅ Aprovado: " : "✖️ Recusado: ") + "<b>" + esc(r?.nome ?? String(alvo)) + "</b>" });
    if (ok) {
      await fixarPainel(alvo).catch(() => {});
      await enviar(alvo, "Seu acesso ao <b>TEMPO-RJ</b> foi aprovado! Escolha as regiões e toque em <b>Concluir</b>:",
                   { reply_markup: teclado([], false) });
    }
    return;
  }

  let regioes: string[] = u.regioes ?? [];
  let todas: boolean = !!u.todas;
  if (d === "fim") {
    await resp();
    await tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, parse_mode: "HTML",
      text: "Combinado. Você acompanha: <b>" + esc(resumoRegioes({ regioes, todas })) + "</b>.\n" +
            "Para mudar, use /regioes no Menu." });
    return;
  }
  if (d === "t:all") {
    todas = !todas;
    if (!todas) regioes = [];
  } else if (d.startsWith("t:")) {
    const r = REGIOES[Number(d.slice(2))];
    if (!r) { await resp(); return; }
    if (todas) { todas = false; regioes = REGIOES.filter((x) => x !== r); }   // desmarcar uma de "todas"
    else regioes = regioes.includes(r) ? regioes.filter((x) => x !== r) : [...regioes, r];
    if (regioes.length === REGIOES.length) { todas = true; regioes = []; }
  }
  await rpc("tempo_tg_regioes", { p_chat: chat, p_regioes: regioes, p_todas: todas });
  await resp();
  await tg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id,
                                       reply_markup: teclado(regioes, todas) });
}

// ------------------------------------------------------------ aviso de trovoada
// Modelo aprovado pelo usuario em 08/11: todo aviso responde, na mesma ordem,
// O QUE · ONDE · QUANDO · O QUE ESPERAR · O QUE FAZER — para a pessoa entender
// sem abrir o painel.
// Regra nova em 13/11 (D17): "a_caminho" = trovoada a 10-30 km, SEM horario
// de chegada (era precisao falsa). Cada municipio leva a chance APRENDIDA da sua
// faixa (sql/101): o banco confere cada aviso 2 h depois e corrige a taxa.
type Mun = { nome: string; situacao: string; dist_km: number | null;
  vem_de?: string | null; chance?: number | null };
type Item = { regiao: string; tipo: string; silencioso: boolean; municipios: Mun[]; quadro: string;
  desempenho?: { verificados: number; acertos: number } };

const LADO: Record<string, string> = { norte: "ao norte", sul: "ao sul", leste: "a leste", oeste: "a oeste",
  nordeste: "a nordeste", noroeste: "a noroeste", sudeste: "a sudeste", sudoeste: "a sudoeste" };
const pct = (c: number | null | undefined) => c != null ? `${Math.round(c * 100)}%` : "";
function linhaProxima(m: Mun): string {
  const onde = [m.dist_km != null ? `~${Math.round(m.dist_km)} km` : "", m.vem_de ? LADO[m.vem_de] ?? "" : ""]
    .filter(Boolean).join(" ");
  return `• ${esc(m.nome)}` + (onde ? ` — trovoada a ${onde}` : "") +
         (m.chance != null ? ` · <b>${pct(m.chance)}</b> de chance de chegar` : "");
}

function blocoRegiao(it: Item): string {
  const muns = it.municipios ?? [];
  const no = muns.filter((m) => m.situacao === "no_municipio");
  const cam = muns.filter((m) => m.situacao === "a_caminho");
  const nomes = (ms: Mun[]) => ms.map((m) => esc(m.nome)).join(", ");
  if (it.tipo === "afastou") {
    return `✅ <b>TROVOADA SE AFASTOU · ${esc(it.regiao)}</b>\n` +
           "Sem descargas a até 50 km na última hora. O risco imediato passou.\n" +
           `<b>Origem:</b> descargas atmosféricas detectadas pela Força Aérea (REDEMET), leitura das ${hm(it.quadro)}.`;
  }
  if (it.tipo === "no_municipio") {
    return [`⚡⚡ <b>TROVOADA SOBRE A CIDADE · ${esc(it.regiao)}</b>`,
      `<b>Onde:</b> ${nomes(no)} (descargas a até 10 km)`,
      ...(cam.length ? ["<b>Próxima também:</b>", ...cam.map(linhaProxima)] : []),
      "<b>O que esperar:</b> raios, chuva forte e rajadas nos próximos 30 a 60 minutos.",
      `<b>Origem:</b> descargas atmosféricas detectadas pela Força Aérea (REDEMET) a até 10 km do município nos últimos 20 min — leitura das ${hm(it.quadro)}.`,
      "<b>O que fazer:</b> fique em local fechado e tire aparelhos sensíveis da tomada."].join("\n");
  }
  return [`⚡ <b>TROVOADA PRÓXIMA · ${esc(it.regiao)}</b>`,
    "<b>Onde:</b>", ...cam.map(linhaProxima),
    "<b>Quando:</b> pode chegar na próxima hora — ou se desfazer antes. Trovoada de verão costuma nascer e morrer no mesmo lugar.",
    "<b>O que esperar:</b> se chegar, raios, chuva forte por pouco tempo e rajadas de vento. Pode faltar energia.",
    `<b>Origem:</b> descargas atmosféricas detectadas pela Força Aérea (REDEMET) a 10-30 km do município nos últimos 20 min. Leitura das ${hm(it.quadro)}.`,
    "<b>O que fazer:</b> recolha o que estiver solto, evite áreas abertas e carregue o celular."].join("\n");
}
function rodapeTrovoada(itens: Item[]): string {
  // a confianca MEDIDA: o banco confere cada aviso 2 h depois (sql/101)
  if (!itens.some((p) => (p.municipios ?? []).some((m) => m.situacao === "a_caminho"))) return "";
  const d = itens.find((p) => p.desempenho)?.desempenho;
  if (d && d.verificados >= 20)
    return `\n<i>A chance é aprendida: nos últimos 90 dias, ${Math.round(100 * d.acertos / d.verificados)}% dos ` +
           `${d.verificados} avisos de trovoada próxima conferidos se confirmaram. Cada aviso é conferido 2 h depois e corrige a conta.</i>`;
  return "\n<i>A chance começou nos testes com as tempestades de jan-jul/2026 e se corrige sozinha: " +
         "cada aviso é conferido 2 h depois.</i>";
}

// Pedido do usuario (08/11): trovoada a caminho ou sobre a cidade dispara
// TAMBEM o aviso de risco eletrico — duas mensagens, uma de cada.
function blocoRiscoTrovoada(it: Item): string {
  const muns = (it.municipios ?? []).filter((m) => m.situacao === "a_caminho" || m.situacao === "no_municipio");
  const sobre = it.tipo === "no_municipio";
  return [`🔌 <b>RISCO DE FALTA DE ENERGIA AGORA · ${esc(it.regiao)}</b>`,
    `<b>Onde:</b> ${muns.map((m) => esc(m.nome)).join(", ")}`,
    `<b>Por quê:</b> ${sobre ? "trovoada sobre a cidade" : "trovoada próxima, que pode chegar"} (descargas atmosféricas e rajadas)`,
    "<b>O que significa:</b> raios e rajadas de tempestade costumam provocar desligamentos na rede elétrica.",
    `<b>Origem:</b> aviso de trovoada do TEMPO-RJ, com base nas descargas detectadas pela Força Aérea (REDEMET) — leitura das ${hm(it.quadro)}.`,
    "<b>O que fazer:</b> carregue celulares e lanternas e tire aparelhos sensíveis da tomada."].join("\n");
}

type Dest = { chat_id: number; regioes: string[]; todas: boolean };
const segue = (d: Dest, regiao: string) => d.todas || d.regioes.includes(regiao);
const ordemRegiao = (a: { regiao: string }, b: { regiao: string }) => REGIOES.indexOf(a.regiao) - REGIOES.indexOf(b.regiao);

// Um card por regiao; trovoada chegando ou sobre a cidade gera TAMBEM o card
// de risco eletrico (pedido do usuario, 08/11: dois avisos).
async function jobsTrovoada(dest: Dest[], quando: string): Promise<Job[]> {
  const plano = ((await rpc("tempo_tg_plano_trovoada")) as Item[]).sort(ordemRegiao);
  const jobs: Job[] = [];
  for (const it of plano) {
    const quem = dest.filter((d) => segue(d, it.regiao));
    if (!quem.length) continue;
    const a = K.avisoTrovoada(it as K.ItemTrovoada, quando);
    jobs.push({ tipo: "trovoada", regiao: it.regiao, card: { k: "aviso", a }, legenda: legendaAviso(a, it.regiao),
                texto: blocoRegiao(it) + rodapeTrovoada([it]),
                destinos: quem.map((d) => ({ chat: d.chat_id, silencioso: it.silencioso })) });
    if (it.tipo === "a_caminho" || it.tipo === "no_municipio") {
      const r = K.avisoRiscoTrovoada(it as K.ItemTrovoada, quando);
      jobs.push({ tipo: "risco_trovoada", regiao: it.regiao, card: { k: "aviso", a: r }, legenda: legendaAviso(r, it.regiao),
                  texto: blocoRiscoTrovoada(it), destinos: quem.map((d) => ({ chat: d.chat_id, silencioso: false })) });
    }
  }
  return jobs;
}

// ------------------------------------------------------------ avisos imediatos 2 a 5
// Mesmo modelo (O que · Onde · Quando · O que esperar · O que fazer). A decisao
// de O QUE avisar (e a memoria do que ja foi dito) fica no banco:
// tempo_tg_plano_alertas.
type Alerta = { tipo: string; regiao: string; [k: string]: any };

function diaHora(iso: string): string {
  const t = new Date(new Date(iso).getTime() - 3 * 3_600_000), h = new Date(Date.now() - 3 * 3_600_000);
  const mesmo = t.toISOString().slice(0, 10) === h.toISOString().slice(0, 10);
  const dia = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][t.getUTCDay()];
  return mesmo ? `${hm(iso)} de hoje`
    : `${dia} ${String(t.getUTCDate()).padStart(2, "0")}/${String(t.getUTCMonth() + 1).padStart(2, "0")} ${hm(iso)}`;
}
// O INMET manda os riscos como ["frase. Risco de ..."]: a primeira frase diz o
// que vem (chuva de tanto, vento de tanto); o resto, as consequencias.
function partesRiscos(r: string | null): { esperar: string; riscos: string } {
  if (!r) return { esperar: "", riscos: "" };
  let s = r.trim();
  if (s.startsWith("[")) { try { s = String(JSON.parse(s)[0] ?? ""); } catch { /* fica como veio */ } }
  s = s.replace(/\s+/g, " ");
  const k = s.search(/\.\s+(?=Risco|Baixo|Alto|Grande)/);
  const esperar = (k >= 0 ? s.slice(0, k) : s).replace(/\.\s*$/, "");
  let riscos = k >= 0 ? s.slice(k + 1).trim().replace(/\.\s*$/, "") : "";
  riscos = riscos.replace(/^(Baixo |Alto |Grande )?[Rr]isco (potencial )?de /, "");
  return { esperar, riscos: riscos ? riscos[0].toUpperCase() + riscos.slice(1) : "" };
}
const lista = (xs: string[]) => xs.map(esc).join(", ");

function blocoAlerta(a: Alerta): string {
  if (a.tipo === "inmet") {
    const verm = a.severidade === "grande_perigo";
    const cor = verm ? "VERMELHO" : "LARANJA";
    const titulo = a.como === "elevou"
      ? `🔴 <b>INMET ELEVOU PARA ALERTA VERMELHO · ${esc(a.descricao)} · ${esc(a.regiao)}</b>`
      : `${verm ? "🔴" : "🟠"} <b>ALERTA ${cor} DO INMET · ${esc(a.descricao)} · ${esc(a.regiao)}</b>`;
    const comecou = new Date(a.inicio).getTime() <= Date.now();
    const p = partesRiscos(a.riscos);
    return [titulo,
      `<b>Nível:</b> ${verm ? "Grande Perigo (3º de 3 níveis" : "Perigo (2º de 3 níveis"}: amarelo, laranja, vermelho)`,
      `<b>Onde:</b> ${lista(a.municipios)}` + (a.como === "entrou" ? " (entraram agora no alerta)" : ""),
      `<b>Quando:</b> ${comecou ? "até " + diaHora(a.fim) : "de " + diaHora(a.inicio) + " até " + diaHora(a.fim)}`,
      ...(p.esperar ? [`<b>O que esperar:</b> ${esc(p.esperar)}.`] : []),
      ...(p.riscos ? [`<b>Riscos:</b> ${esc(p.riscos)}.`] : []),
      `<b>Origem:</b> aviso oficial do INMET (Instituto Nacional de Meteorologia), nível ${verm ? "Grande Perigo" : "Perigo"}, publicado para estes municípios.`].join("\n");
  }
  if (a.tipo === "dc") {
    // um bloco por tipo e nivel: deslizamento e enchente pedem cuidados diferentes
    const TXT: Record<string, [string, string, string]> = {
      geologico: ["DESLIZAMENTO", "o solo está encharcado e há chance real de deslizamento em encostas.",
        "fique atento a rachaduras, estalos e água barrenta nas encostas. Em caso de risco, Defesa Civil: <b>199</b>."],
      hidrologico: ["ENCHENTE", "rios e córregos podem transbordar e alagar as áreas próximas.",
        "evite margens de rios e ruas que costumam alagar. Em caso de risco, Defesa Civil: <b>199</b>."] };
    const blocos: string[] = [];
    for (const tipo of ["geologico", "hidrologico"]) {
      for (const nv of ["muito_alto", "alto"]) {
        const ms = a.itens.filter((i: any) => i.tipo === tipo && i.nivel === nv).map((i: any) => i.municipio);
        if (!ms.length) continue;
        const t = TXT[tipo];
        blocos.push([`🏔️ <b>DEFESA CIVIL · RISCO ${nv === "muito_alto" ? "MUITO ALTO" : "ALTO"} DE ${t[0]} · ${esc(a.regiao)}</b>`,
          `<b>Onde:</b> ${lista(ms)}`, `<b>O que significa:</b> ${t[1]}`,
          `<b>Origem:</b> Defesa Civil do Estado do RJ (painel CEMADEN-RJ) — nível de risco ${tipo === "geologico" ? "geológico" : "hidrológico"} publicado oficialmente para o município.`,
          `<b>O que fazer:</b> ${t[2]}`].join("\n"));
      }
    }
    return blocos.join("\n\n");
  }
  if (a.tipo === "risco") {
    const fator = a.fator && a.fator >= 1.5
      ? `o TEMPO-RJ espera cerca de ${Number(a.fator).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} vezes mais ocorrências na rede elétrica do que num dia normal.`
      : "o TEMPO-RJ espera bem mais ocorrências na rede elétrica do que num dia normal.";
    return [`🔌 <b>RISCO ALTO DE FALTA DE ENERGIA ${String(a.quando).toUpperCase()} · ${esc(a.regiao)}</b>`,
      `<b>Onde:</b> ${lista(a.municipios)}`,
      `<b>Por quê:</b> ${esc(a.motivo)}`,
      `<b>O que significa:</b> ${fator}`,
      "<b>Origem:</b> modelo de impacto do TEMPO-RJ — a previsão das 8 famílias de modelos meteorológicos " +
        "(rajada, chuva por hora e instabilidade) aplicada ao histórico de interrupções de energia da ANEEL em cada município.",
      "<b>O que fazer:</b> carregue celulares e lanternas e evite deixar a geladeira cheia de perecíveis."].join("\n");
  }
  if (a.tipo === "chuva") {
    const n0 = (v: number) => Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
    return [`🌧️ <b>CHUVA FORTE AGORA · ${esc(a.regiao)}</b>`,
      ...a.itens.map((i: any) => `<b>Onde:</b> ${esc(i.municipio)} — ` +
        (i.mm1h >= 30 ? `${n0(i.mm1h)} mm na última hora` : `${n0(i.mm24)} mm em 24 h`) + " (pluviômetro)"),
      "<b>O que significa:</b> chuva intensa, com risco de alagamento em pontos baixos nas próximas horas.",
      "<b>Origem:</b> chuva medida pelos pluviômetros do CEMADEN e do Alerta Rio no município" +
        (a.itens[0]?.hora ? ` — leitura das ${hm(a.itens[0].hora)}` : "") + ". Limite do aviso: 30 mm em 1 hora ou 50 mm em 24 horas.",
      "<b>O que fazer:</b> evite ruas que costumam alagar e não atravesse água corrente."].join("\n");
  }
  return "";
}

// INMET, Defesa Civil, risco eletrico previsto e chuva forte: um card por
// aviso (Defesa Civil: um por tipo e nivel).
async function jobsAlertas(dest: Dest[], quando: string): Promise<Job[]> {
  const plano = ((await rpc("tempo_tg_plano_alertas")) as Alerta[]).sort(ordemRegiao);
  const jobs: Job[] = [];
  for (const a of plano) {
    const quem = dest.filter((d) => segue(d, a.regiao));
    if (!quem.length) continue;
    const texto = blocoAlerta(a);
    for (const av of K.avisosAlerta(a, quando)) {
      jobs.push({ tipo: "alerta", regiao: a.regiao, card: { k: "aviso", a: av }, legenda: legendaAviso(av, a.regiao),
                  texto, destinos: quem.map((d) => ({ chat: d.chat_id, silencioso: false })) });
    }
  }
  return jobs;
}

// Falha da REDEMET (16/11: 1h43 sem quadro, ninguem soube). Um aviso de texto
// so para o administrador quando cai e outro quando volta; o banco garante que
// sai uma vez so por falha (tempo_tg_redemet_situacao).
async function avisoRedemet(): Promise<string | null> {
  const s = await rpc("tempo_tg_redemet_situacao");
  if (!s?.acao) return null;
  const texto = s.acao === "falha"
    ? `⚠️ <b>REDEMET sem dados de raios desde ${hm(s.desde)}</b>\n` +
      "Enquanto não voltar, o TEMPO-RJ não enxerga trovoada: não sai aviso e o boletim mostra \"sem leitura\". " +
      "A falha é da fonte (Força Aérea), o coletor segue tentando a cada 6 min."
    : `✅ <b>REDEMET voltou</b>: leitura das ${hm(s.voltou)}. ` +
      `Ficou sem dados de ${hm(s.desde)} a ${hm(s.voltou)}.`;
  for (const adm of (await rpc("tempo_tg_admins")) as number[]) await enviar(adm, texto, { disable_notification: s.acao === "volta" });
  return s.acao;
}

// Trovoada e os demais avisos na mesma rodada; um tipo falhar nao derruba o outro.
async function avisosTodos() {
  const r: Record<string, unknown> = {};
  const dest = (await rpc("tempo_tg_destinatarios")) as Dest[];
  const quando = agoraTxt();
  const jobs: Job[] = [];
  try { jobs.push(...await jobsTrovoada(dest, quando)); } catch (e) { r.erro_trovoada = e instanceof Error ? e.message : String(e); }
  try { jobs.push(...await jobsAlertas(dest, quando)); } catch (e) { r.erro_alertas = e instanceof Error ? e.message : String(e); }
  try { r.redemet = await avisoRedemet(); } catch (e) { r.erro_redemet = e instanceof Error ? e.message : String(e); }
  r.cards = jobs.length;
  umToque(jobs);
  r.enviados = jobs.length ? await processar(jobs) : 0;
  if (r.erro_trovoada || r.erro_alertas) throw new Error([r.erro_trovoada, r.erro_alertas].filter(Boolean).join(' | '));
  return r;
}

// ------------------------------------------------------------ boletim de 6 em 6 h
// Numeros do painel (tempo_tg_boletim faz as contas do renderHero) e chuva
// medida pelos pluviometros. Aqui so se escolhe o municipio mais critico de
// cada regiao (media esconderia o municipio que vai sofrer) e se monta o card.
type MunB = { municipio: string; k6: number; chance6: number | null; k_forte: number;
  mm24: number | null; p25_24: number | null; p75_24: number | null; raj24: number | null;
  tmax: number | null; tmin: number | null; mm_hoje: number | null; mm_mes: number | null;
  normal_mes: number | null; risco_hoje: string | null; risco_amanha: string | null;
  risco_hoje_p: number | null; risco_amanha_p: number | null };
type RegB = { regiao: string; muns: MunB[]; inmet: { descricao: string; severidade: string; fim: string | null; n: number }[];
  dc: { tipo: string; nivel: string; muns: string[] }[] };

const nf = (v: number, c = 1) => v.toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c });
const SEV: Record<string, [string, number]> = { perigo_potencial: ["🟡", 1], perigo: ["🟠", 2], grande_perigo: ["🔴", 3] };
const RISCO: Record<string, [string, string]> = {
  alto: ["🔴", "Alto"], elevado: ["🟠", "Elevado"], moderado: ["🟡", "Moderado"], normal: ["⚪", "Normal"] };
const DC_TIPO: Record<string, string> = { geologico: "Risco geológico (deslizamentos)", hidrologico: "Risco hidrológico (enchentes)" };
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto",
               "setembro", "outubro", "novembro", "dezembro"];

// "Previsto para o mes" = a normal climatologica do mes (1991-2020), a mesma
// do painel. Palavras do usuario (08/11): "% do previsto para o mes".
function pctMes(mm: number | null | undefined, normal: number | null | undefined): string {
  if (!normal || mm == null) return "–";
  const p = 100 * mm / normal;
  // "menos de 1%" e nao "<1%": a mensagem vai em HTML e o Telegram le "<1%" como
  // tag e RECUSA a mensagem inteira (08/11: 3 cards do boletim das 12h perdidos).
  return p > 0 && p < 1 ? "menos de 1%" : `${Math.round(p)}%`;
}
function pior<T>(xs: T[], v: (x: T) => number | null | undefined): T | null {
  let m: T | null = null, mv = -Infinity;
  for (const x of xs) { const y = v(x); if (y != null && y > mv) { mv = y; m = x; } }
  return m;
}
function quando(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(new Date(iso).getTime() - 3 * 3_600_000), h = new Date(Date.now() - 3 * 3_600_000);
  const mesmoDia = t.toISOString().slice(0, 10) === h.toISOString().slice(0, 10);
  return " até " + (mesmoDia ? "" : String(t.getUTCDate()).padStart(2, "0") + "/" +
    String(t.getUTCMonth() + 1).padStart(2, "0") + " ") + hm(iso);
}

// Risco: lista os municipios dos niveis mais altos; o nivel de baixo, que
// cobre todo o resto, vira "demais" (como no modelo aprovado). Cada nivel leva
// a chance de dia ruim (pedido do usuario, 08/11). Ela vem em FAIXAS, como no
// painel: no mesmo nivel costuma ser o mesmo numero, entao sai uma vez por
// nivel; se variar, sai o maior ("ate X%").
function chanceDiaRuim(ps: (number | null)[]): string {
  const v = ps.filter((p): p is number => p != null).map((p) => Math.round(100 * p));
  if (!v.length) return "";
  const mx = Math.max(...v), mn = Math.min(...v);
  return ` — ${mx === mn ? "" : "até "}${mx}% de chance de dia ruim`;
}
function linhasRisco(ms: MunB[]): string[] {
  const nv = (m: MunB) => (m.risco_hoje && RISCO[m.risco_hoje]) ? m.risco_hoje : null;
  const presentes = ["alto", "elevado", "moderado", "normal"].filter((k) => ms.some((m) => nv(m) === k));
  if (!presentes.length) return ["sem cálculo para hoje"];
  const ch = (k: string) => chanceDiaRuim(ms.filter((m) => nv(m) === k).map((m) => m.risco_hoje_p));
  if (presentes.length === 1) return [`${RISCO[presentes[0]][0]} ${RISCO[presentes[0]][1]}${ch(presentes[0])}: todos os municípios`];
  return presentes.map((k, i) => `${RISCO[k][0]} ${RISCO[k][1]}${ch(k)}: ` + (i === presentes.length - 1 ? "demais"
    : ms.filter((m) => nv(m) === k).map((m) => esc(m.municipio)).join(", ")));
}

// O CARD de uma regiao, no modelo aprovado pelo usuario em 07/11.
function cardRegiao(r: RegB, rotuloHora: string): string {
  const ms = r.muns ?? [];
  const p6 = pior(ms, (m) => m.chance6) ?? ms[0];
  const kf = Math.max(0, ...ms.map((m) => m.k_forte ?? 0));
  const mm = pior(ms, (m) => m.mm24) ?? ms[0];
  const raj = Math.max(0, ...ms.map((m) => m.raj24 ?? 0));
  const tmax = Math.max(...ms.map((m) => m.tmax ?? -99)), tmin = Math.min(...ms.map((m) => m.tmin ?? 99));
  const medHoje = pior(ms, (m) => m.mm_hoje);
  const medMes = pior(ms, (m) => (m.mm_mes != null && m.normal_mes ? m.mm_mes / m.normal_mes : null));
  const mes = MESES[new Date(Date.now() - 3 * 3_600_000).getUTCMonth()];

  const L: string[] = [];
  L.push(`⛅ <b>TEMPO-RJ · ${esc(r.regiao)}</b> · boletim ${rotuloHora}`, "");
  L.push("<b>Próximas 6 h</b>");
  L.push(`${p6.k6} de 8 famílias preveem chuva (${Math.round(100 * p6.k6 / 8)}%) → ` +
         (p6.chance6 != null ? `<b>${nf(100 * p6.chance6)}% de chance</b> de virar chuva realmente` : "tabela de chance indisponível"), "");
  L.push("<b>Próximas 24 h</b>");
  L.push(`Chuva forte: ${kf} de 8 famílias`);
  L.push(`Previsto ~${nf(mm.mm24 ?? 0)} mm` +
         (mm.p25_24 != null && mm.p75_24 != null ? ` (metade central: ${nf(mm.p25_24)}–${nf(mm.p75_24)} mm)` : ""));
  if (mm.normal_mes) L.push(`A previsão de ~${nf(mm.mm24 ?? 0)} mm para as próximas 24 h são ${pctMes(mm.mm24, mm.normal_mes)} do previsto para o mês`);
  L.push(`Rajada máxima ${Math.round(raj)} km/h` +
         (tmax > -99 ? ` · Temperatura ${Math.round(tmin)}–${Math.round(tmax)} °C` : ""), "");
  L.push("<b>Chuva medida</b>");
  if (!medHoje && !medMes) {
    L.push("sem pluviômetro com leitura nesta região");
  } else {
    L.push(`Hoje até agora: ${nf(medHoje?.mm_hoje ?? 0)} mm` +
           (medHoje?.normal_mes ? ` = ${pctMes(medHoje.mm_hoje, medHoje.normal_mes)} do previsto para o mês` : ""));
    // formato pedido pelo usuario (10/11): o previsto do mes primeiro, depois o acumulado
    if (medMes) L.push(`Previsto no mês ${nf(medMes.normal_mes!, 0)} mm: Acumulado ${nf(medMes.mm_mes!, 0)} mm = ` +
                       `<b>${pctMes(medMes.mm_mes, medMes.normal_mes)} do previsto para o mês</b>`);
  }
  L.push("", "⚡ <b>Risco elétrico hoje</b>", ...linhasRisco(ms), "", "<b>Alertas em vigor</b>");
  // mesmo aviso em dois niveis (amarelo para uns municipios, laranja para outros): fica o pior
  const porDesc = new Map<string, RegB["inmet"][0]>();
  for (const a of r.inmet) {
    const at = porDesc.get(a.descricao);
    if (!at || (SEV[a.severidade]?.[1] ?? 4) > (SEV[at.severidade]?.[1] ?? 4)) porDesc.set(a.descricao, a);
  }
  const al = [...porDesc.values()].sort((a, b) => (SEV[b.severidade]?.[1] ?? 4) - (SEV[a.severidade]?.[1] ?? 4));
  for (const a of al) L.push(`${(SEV[a.severidade] ?? ["⚠️"])[0]} INMET · ${esc(a.descricao)}${quando(a.fim)}`);
  for (const d of r.dc) {
    L.push(`${d.nivel === "muito_alto" ? "🔴" : "🟠"} Defesa Civil · ${DC_TIPO[d.tipo] ?? d.tipo} ` +
           `${d.nivel === "muito_alto" ? "muito alto" : "alto"}: ${d.muns.map(esc).join(", ")}`);
  }
  if (!al.length && !r.dc.length) L.push("nenhum");
  return L.join("\n");
}

// UM CARD POR REGIAO, cada um numa mensagem (decisao do usuario, 08/11).
// Quem segue varias regioes recebe varios cards; so o primeiro da rodada toca,
// os outros chegam sem som — senao "Todas" seriam 11 toques seguidos.
// Em imagem (13/11): uma imagem por regiao, desenhada uma vez e mandada a
// todos que seguem a regiao, em ordem; o resto da fila segue em ?acao=fila.
function nivelPior(ms: MunB[], campo: "risco_hoje" | "risco_amanha"): string | null {
  return ["alto", "elevado", "moderado", "normal"].find((k) => ms.some((m) => (m as any)[campo] === k)) ?? null;
}
function legendaRegiao(r: RegB, rotulo: string): string {
  const ms = r.muns ?? [];
  const p6 = pior(ms, (m) => m.chance6), mm = pior(ms, (m) => m.mm24), rk = nivelPior(ms, "risco_hoje");
  return `<b>⛅ ${esc(r.regiao)} · boletim ${rotulo}</b>\n` +
    `Próximas 6 h: ${p6?.chance6 != null ? nf(100 * p6.chance6) + "%" : "–"} de chance de chuva · 24 h: ~${nf(mm?.mm24 ?? 0)} mm` +
    (rk ? `\nRisco de falta de energia hoje: ${RISCO[rk][1].toLowerCase()}` : "");
}
async function boletim(soChat?: number) {
  const regs = ((await rpc("tempo_tg_boletim")) as RegB[]).sort(ordemRegiao);
  const dest = (await rpc("tempo_tg_destinatarios")) as Dest[];
  const agora = new Date(Date.now() - 3 * 3_600_000);
  const meiaNoite = agora.getUTCHours() < 3;                 // o das 00h sai todo sem som
  const rotuloHora = soChat ? hm(new Date().toISOString())   // pedido na hora: hora exata
    : String(Math.round(agora.getUTCHours() + agora.getUTCMinutes() / 60) % 24).padStart(2, "0") + "h";
  const quando = agoraTxt();
  const jobs: Job[] = regs.map((r) => ({
    tipo: "boletim", regiao: r.regiao, card: { k: "regiao" as const, r, rotulo: rotuloHora, quando },
    legenda: legendaRegiao(r, rotuloHora), texto: cardRegiao(r, rotuloHora),
    destinos: dest.filter((d) => (!soChat || d.chat_id === soChat) && segue(d, r.regiao))
                  .map((d) => ({ chat: d.chat_id, silencioso: meiaNoite && !soChat })),
  })).filter((j) => j.destinos.length);
  umToque(jobs);
  return { regioes: regs.length, cards: jobs.length, enviados: await processar(jobs) };
}

// ------------------------------------------------------------ /boletim de um municipio
// Pedido do usuario em 08/11: escolher UM municipio e receber na hora a "foto
// do que esta no site" para ele. Escolha em dois passos (regiao -> municipio):
// 92 botoes numa lista so seriam impraticaveis no celular. Ou digitado:
// "/boletim Petropolis", com ou sem acento.
type MunInfo = { ibge: number; nome: string; regiao: string };
const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// prefixo "b" = /boletim, "o" = /ouvi (mesma escolha regiao -> municipio)
function tecladoRegioesMun(p = "b") {
  const linhas: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < REGIOES.length; i += 2) {
    linhas.push(REGIOES.slice(i, i + 2).map((r, k) => ({ text: r, callback_data: `${p}:r:` + (i + k) })));
  }
  return { inline_keyboard: linhas };
}
function tecladoMunicipios(muns: MunInfo[], p = "b") {
  const linhas: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < muns.length; i += 2) {
    linhas.push(muns.slice(i, i + 2).map((m) => ({ text: m.nome, callback_data: `${p}:m:` + m.ibge })));
  }
  linhas.push([{ text: "← Regiões", callback_data: `${p}:mun` }]);
  return { inline_keyboard: linhas };
}
function acharMunicipios(todos: MunInfo[], termo: string): MunInfo[] {
  const t = semAcento(termo);
  const exato = todos.filter((m) => semAcento(m.nome) === t);
  return exato.length ? exato : todos.filter((m) => semAcento(m.nome).includes(t));
}
const MENU_BOLETIM = { inline_keyboard: [[
  { text: "📍 Um município", callback_data: "b:mun" },
  { text: "🗺️ Minhas regiões", callback_data: "b:reg" }]] };

const NIVEL_DC: Record<string, [string, string]> = {
  muito_baixo: ["⚪", "muito baixo"], baixo: ["⚪", "baixo"], moderado: ["🟡", "moderado"],
  alto: ["🟠", "alto"], muito_alto: ["🔴", "muito alto"] };

function linhaTrovoada(t: any): string {
  if (!t) return "⚪ Sem leitura da REDEMET";
  const km = (v: number | null) => v != null ? `~${Math.round(v)} km` : "menos de 50 km";
  switch (t.situacao) {
    case "no_municipio": return "🔴 <b>No município</b> (descarga a até 10 km nos últimos 20 min)";
    case "a_caminho": {
      const partes = [`🟠 <b>Próxima</b>: a ${km(t.dist_km)}` + (t.vem_de ? ` ${LADO[t.vem_de] ?? ""}` : "")];
      if (t.chance != null) partes.push(`${pct(t.chance)} de chance de chegar`);
      return partes.join(" · ");
    }
    case "perto": return `🟡 <b>Por perto</b>: a ${t.dist_km != null && t.dist_km <= 50 ? km(t.dist_km) : "até 50 km"}, sem se aproximar`;
    case "sem_dado": return `⚪ <b>Sem leitura da REDEMET desde ${hm(t.quadro)}</b> — trovoada pode estar ocorrendo sem ser vista`;
    default: return "⚪ Sem trovoada a até 50 km";
  }
}

function cardMunicipio(m: any): string {
  const mes = MESES[new Date(Date.now() - 3 * 3_600_000).getUTCMonth()];
  const L: string[] = [];
  L.push(`📍 <b>TEMPO-RJ · ${esc(m.municipio)}</b> · ${esc(m.regiao)} · agora ${hm(new Date().toISOString())}`, "");
  L.push("<b>Próximas 6 h</b>");
  L.push(`${m.k6} de 8 famílias preveem chuva (${Math.round(100 * m.k6 / 8)}%) → ` +
         (m.chance6 != null ? `<b>${nf(100 * m.chance6)}% de chance</b> de virar chuva realmente` : "tabela de chance indisponível"), "");
  L.push("<b>Próximas 24 h</b>");
  L.push(`Chuva forte: ${m.k_forte} de 8 famílias`);
  L.push(`Previsto ~${nf(m.mm24 ?? 0)} mm` +
         (m.p25_24 != null && m.p75_24 != null ? ` (metade central: ${nf(m.p25_24)}–${nf(m.p75_24)} mm)` : ""));
  if (m.normal_mes) L.push(`A previsão de ~${nf(m.mm24 ?? 0)} mm para as próximas 24 h são ${pctMes(m.mm24, m.normal_mes)} do previsto para o mês`);
  L.push(`Rajada máxima ${Math.round(m.raj24 ?? 0)} km/h` +
         (m.tmax != null ? ` · Temperatura ${Math.round(m.tmin)}–${Math.round(m.tmax)} °C` : ""), "");
  L.push("<b>Chuva medida</b>");
  if (m.mm_mes == null && m.mm_hoje == null) {
    L.push("sem pluviômetro com leitura neste município");
  } else {
    L.push(`Hoje até agora: ${nf(m.mm_hoje ?? 0)} mm` +
           (m.normal_mes ? ` = ${pctMes(m.mm_hoje, m.normal_mes)} do previsto para o mês` : ""));
    if (m.mm_mes != null && m.normal_mes) {
      L.push(`Previsto no mês ${nf(m.normal_mes, 0)} mm: Acumulado ${nf(m.mm_mes, 0)} mm = ` +
             `<b>${pctMes(m.mm_mes, m.normal_mes)} do previsto para o mês</b>`);
    }
  }
  const rv = (n: string | null, p: number | null) =>
    n && RISCO[n] ? `${RISCO[n][0]} ${RISCO[n][1]}` + (p != null ? ` — ${Math.round(100 * p)}% de chance de dia ruim` : "") : "sem cálculo";
  L.push("", "⚡ <b>Risco elétrico</b>", `Hoje: ${rv(m.risco_hoje, m.risco_hoje_p)}`, `Amanhã: ${rv(m.risco_amanha, m.risco_amanha_p)}`);
  L.push("", "<b>Trovoada agora</b>", linhaTrovoada(m.trovoada));
  L.push("", "<b>Alertas em vigor</b>");
  const porDesc = new Map<string, any>();
  for (const a of m.inmet ?? []) {
    const at = porDesc.get(a.descricao);
    if (!at || (SEV[a.severidade]?.[1] ?? 4) > (SEV[at.severidade]?.[1] ?? 4)) porDesc.set(a.descricao, a);
  }
  const al = [...porDesc.values()].sort((a, b) => (SEV[b.severidade]?.[1] ?? 4) - (SEV[a.severidade]?.[1] ?? 4));
  for (const a of al) L.push(`${(SEV[a.severidade] ?? ["⚠️"])[0]} INMET · ${esc(a.descricao)}${quando(a.fim)}`);
  if (!al.length) L.push("INMET: nenhum");
  // Defesa Civil: os dois riscos sempre, em qualquer nivel — como no painel
  for (const tipo of ["hidrologico", "geologico"]) {
    const d = (m.dc ?? []).find((x: any) => x.tipo === tipo);
    const nv = d ? (NIVEL_DC[d.nivel] ?? ["⚠️", d.nivel]) : ["⚪", "sem dado"];
    L.push(`${nv[0]} Defesa Civil · ${DC_TIPO[tipo]}: ${nv[1]}`);
  }
  return L.join("\n");
}

async function boletimMunicipio(chat: number, ibge: number) {
  const m = await rpc("tempo_tg_municipio", { p_ibge: ibge });
  if (!m) { await enviar(chat, "Não encontrei esse município."); return; }
  const dias = ((await rpc("tempo_tg_dias", { p_ibge: ibge }).catch(() => [])) ?? []) as K.Dia[];
  const rv = (n: string | null) => n && RISCO[n] ? RISCO[n][1].toLowerCase() : "sem cálculo";
  const legenda = `<b>📍 ${esc(m.municipio)} · agora ${hm(new Date().toISOString())}</b>\n` +
    `Próximas 6 h: ${m.chance6 != null ? nf(100 * m.chance6) + "%" : "–"} de chance de chuva · 24 h: ~${nf(m.mm24 ?? 0)} mm\n` +
    `Risco de falta de energia: hoje ${rv(m.risco_hoje)}, amanhã ${rv(m.risco_amanha)}`;
  await processar([{ tipo: "boletim_municipio", regiao: m.regiao, card: { k: "mun", m, dias, quando: agoraTxt() },
                     legenda, texto: cardMunicipio(m), destinos: [{ chat, silencioso: false }] }]);
}

// "/boletim <nome>": acha o municipio pelo nome, sem acento e sem caixa.
async function buscarMunicipio(chat: number, termo: string) {
  const achados = acharMunicipios((await rpc("tempo_tg_municipios")) as MunInfo[], termo);
  if (achados.length === 1) return boletimMunicipio(chat, achados[0].ibge);
  if (achados.length > 1 && achados.length <= 12) {
    await enviar(chat, `Encontrei ${achados.length} municípios. Qual deles?`, { reply_markup: tecladoMunicipios(achados) });
    return;
  }
  await enviar(chat, `Não encontrei "${esc(termo)}". Escolha a região:`, { reply_markup: tecladoRegioesMun() });
}

// Botoes do /boletim (callback_data "b:...")
async function botaoBoletim(q: any, chat: number, d: string, u: any) {
  const resp = (texto?: string) => tg("answerCallbackQuery", { callback_query_id: q.id, text: texto });
  const msgId = q.message.message_id;
  if (d === "b:reg") {
    await resp();
    if (!u.todas && !u.regioes?.length) { await enviar(chat, "Escolha as regiões primeiro: /regioes"); return; }
    await boletim(chat);
  } else if (d === "b:mun") {
    await resp();
    await tg("editMessageText", { chat_id: chat, message_id: msgId, parse_mode: "HTML",
      text: "📍 Escolha a <b>região</b> do município:", reply_markup: tecladoRegioesMun() });
  } else if (d.startsWith("b:r:")) {
    const reg = REGIOES[Number(d.slice(4))];
    const todos = (await rpc("tempo_tg_municipios")) as MunInfo[];
    await resp();
    await tg("editMessageText", { chat_id: chat, message_id: msgId, parse_mode: "HTML",
      text: `📍 <b>${esc(reg ?? "")}</b> — escolha o município:`,
      reply_markup: tecladoMunicipios(todos.filter((m) => m.regiao === reg)) });
  } else if (d.startsWith("b:m:")) {
    await resp("Montando o boletim…");
    await boletimMunicipio(chat, Number(d.slice(4)));
  } else {
    await resp();
  }
}

// ------------------------------------------------------------ /ouvi: relato de trovoada
// Pedido do usuario (16/11): ouviu trovoada em Sao Pedro da Aldeia sem aviso.
// O relato vira verdade de campo (tempo.trovoada_relato) junto com o que o
// sistema via na hora; a resposta mostra isso, para a pessoa entender por que
// houve ou nao houve aviso.
async function relatar(chat: number, ibge: number, u: any) {
  const r = await rpc("tempo_tg_relatar", { p_chat: chat, p_ibge: ibge });
  if (!r) { await enviar(chat, "Não encontrei esse município."); return; }
  if (r.repetido) {
    await enviar(chat, `Já registrei trovoada em <b>${esc(r.municipio)}</b> há menos de 20 min. Obrigado!`);
    return;
  }
  const agora = hm(new Date().toISOString());
  const L = [`✅ <b>Registrado</b>: trovoada ouvida em <b>${esc(r.municipio)}</b> às ${agora}.`, "", "<b>O que o TEMPO-RJ via</b>"];
  const km = r.menor_30min_km != null ? Math.round(r.menor_30min_km) : null;
  if (r.sem_dado) {
    L.push(`Nada: a REDEMET está sem dados desde ${hm(r.quadro)}. O relato fica como trovoada que o sistema não tinha como ver.`);
  } else if (km == null) {
    L.push(`Nenhuma célula de trovoada no RJ nos últimos 30 min (leitura das ${hm(r.quadro)}). ` +
           "O relato fica como trovoada que a REDEMET não detectou.");
  } else {
    L.push(`Célula mais próxima a ~${km} km` + (r.vem_de ? ` ${LADO[r.vem_de] ?? ""}` : "") + ` (leitura das ${hm(r.quadro)}).`);
    if (r.situacao === "no_municipio") L.push("Já constava como trovoada sobre o município.");
    else if (r.situacao === "a_caminho" && r.chance != null && r.limiar != null && r.chance < r.limiar) {
      L.push(`Chance aprendida de chegar à cidade: ${pct(r.chance)}, abaixo do corte de ${pct(r.limiar)} — ` +
             "por isso o município não saiu como \"Trovoada próxima\".");
    } else if (r.situacao === "a_caminho") L.push(`Constava como "Trovoada próxima" (${pct(r.chance)} de chance de chegar).`);
    else L.push("Fora da faixa de aviso (até 30 km do município).");
  }
  L.push("", "<i>Cada relato guarda a distância em que a trovoada foi ouvida. Com relatos suficientes, " +
            "o corte do aviso pode ser ajustado para trovoada que se ouve, não só a que chega.</i>");
  await enviar(chat, L.join("\n"));
  if (!u?.admin) {   // o administrador fica sabendo dos relatos dos outros
    for (const adm of (await rpc("tempo_tg_admins")) as number[]) {
      await enviar(adm, `🔊 <b>${esc(u?.nome ?? String(chat))}</b> ouviu trovoada em <b>${esc(r.municipio)}</b> às ${agora}` +
                        (km != null && !r.sem_dado ? ` (célula mais próxima a ~${km} km)` : ""), { disable_notification: true }).catch(() => {});
    }
  }
}

// Botoes do /ouvi (callback_data "o:...")
async function botaoOuvi(q: any, chat: number, d: string, u: any) {
  const resp = (texto?: string) => tg("answerCallbackQuery", { callback_query_id: q.id, text: texto });
  const msgId = q.message.message_id;
  if (d === "o:mun") {
    await resp();
    await tg("editMessageText", { chat_id: chat, message_id: msgId, parse_mode: "HTML",
      text: "🔊 Onde você ouviu trovoada? Escolha a <b>região</b>:", reply_markup: tecladoRegioesMun("o") });
  } else if (d.startsWith("o:r:")) {
    const reg = REGIOES[Number(d.slice(4))];
    const todos = (await rpc("tempo_tg_municipios")) as MunInfo[];
    await resp();
    await tg("editMessageText", { chat_id: chat, message_id: msgId, parse_mode: "HTML",
      text: `🔊 <b>${esc(reg ?? "")}</b> — em qual município?`,
      reply_markup: tecladoMunicipios(todos.filter((m) => m.regiao === reg), "o") });
  } else if (d.startsWith("o:m:")) {
    await resp("Registrando…");
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: msgId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await relatar(chat, Number(d.slice(4)), u);
  } else {
    await resp();
  }
}

// ------------------------------------------------------------ configurar (1 vez)
async function configurar() {
  const eu = await tg("getMe", {});
  const url = Deno.env.get("SUPABASE_URL") + "/functions/v1/tempo-telegram";
  await tg("setWebhook", { url, secret_token: await segredoWebhook(),
                           allowed_updates: ["message", "callback_query"],
                           drop_pending_updates: false });   // o /start que ja esta na fila vale
  await tg("setMyCommands", { commands: [
    { command: "boletim", description: "Boletim agora: um município ou suas regiões" },
    { command: "ouvi", description: "Ouviu trovoada? Conte onde: ensina o aviso" },
    { command: "regioes", description: "Escolher as regiões que você acompanha" },
    { command: "parar", description: "Parar de receber avisos" },
    { command: "start", description: "Voltar a receber avisos" },
    { command: "ajuda", description: "Como o bot funciona" },
  ] });
  await tg("setMyDescription", { description:
    "Tempo no estado do Rio de Janeiro, por região: boletim de 6 em 6 h com os números do painel " +
    "TEMPO-RJ e avisos imediatos — trovoada se aproximando, alertas do INMET e da Defesa Civil, " +
    "risco elétrico e chuva forte medida. Acesso mediante aprovação." });
  await tg("setMyShortDescription", { short_description: "Tempo no RJ por região. Painel completo: tempo-rj.vercel.app" });
  return { bot: eu.username, webhook: url };
}

// ------------------------------------------------------------ entrada
Deno.serve(async (req: Request) => {
  if (!TOKEN || !SEGREDO) return json({ erro: "TELEGRAM_TOKEN ou TEMPO_SEGREDO nao configurado" }, 500);
  const acao = new URL(req.url).searchParams.get("acao");

  if (acao) {
    if (req.headers.get("x-tempo-secret") !== SEGREDO) return json({ erro: "nao autorizado" }, 401);
    const t0 = Date.now();
    try {
      // "teste": o boletim so para o(s) administrador(es) — para conferir o
      // formato sem mandar para os outros inscritos.
      const r = acao === "configurar" ? await configurar()
              : acao === "boletim"    ? await boletim()
              : acao === "teste"      ? await boletim(((await rpc("tempo_tg_admins")) as number[])[0])
              : acao === "fila"       ? { enviados: await processar((((await req.json().catch(() => ({}))) as any).jobs ?? []) as Job[]) }
              : acao === "teste_alertas" ? await (async () => {   // so para o administrador
                  const adm = ((await rpc("tempo_tg_admins")) as number[])[0];
                  const dest = ((await rpc("tempo_tg_destinatarios")) as Dest[]).filter((d) => d.chat_id === adm);
                  const jobs = await jobsAlertas(dest, agoraTxt());
                  return { cards: jobs.length, enviados: await processar(jobs) };
                })()
              : acao === "teste_cards" ? await (async () => {     // os 9 avisos de exemplo, so para o administrador
                  const adm = ((await rpc("tempo_tg_admins")) as number[])[0];
                  const jobs: Job[] = K.exemplos(agoraTxt()).map((e) => ({ tipo: "teste_card", regiao: e.nome,
                    card: { k: "aviso" as const, a: e.aviso }, legenda: `<b>Exemplo · ${esc(e.nome)}</b>`, texto: e.nome,
                    destinos: [{ chat: adm, silencioso: true }] }));
                  return { enviados: await processar(jobs) };
                })()
              : acao === "fixar"     ? await (async () => {   // fixa o painel para quem ja esta inscrito
                  const ds = (await rpc("tempo_tg_destinatarios")) as { chat_id: number }[];
                  for (const d of ds) await fixarPainel(d.chat_id).catch(() => {});
                  return { fixados: ds.length };
                })()
              : await avisosTodos();
      if (acao !== "configurar" && acao !== "fixar" && !acao.startsWith("teste")) {
        try {
          await sb.rpc("tempo_log_coleta", { p_fonte: "telegram", p_ms: Date.now() - t0, p_ok: true,
                                             p_n: (r as any).enviados ?? 0, p_erro: null });
        } catch (_) { /* log nunca derruba */ }
      }
      return json({ ok: true, ...r });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await sb.rpc("tempo_log_coleta", { p_fonte: "telegram", p_ms: Date.now() - t0, p_ok: false,
                                           p_n: 0, p_erro: msg.slice(0, 2000) });
      } catch (_) { /* idem */ }
      return json({ ok: false, erro: msg }, 500);
    }
  }

  // Webhook do Telegram. Responde 200 SEMPRE depois de autenticar: erro aqui
  // faria o Telegram reenviar a mesma mensagem em loop.
  if (req.headers.get("x-telegram-bot-api-secret-token") !== await segredoWebhook()) {
    return json({ erro: "nao autorizado" }, 401);
  }
  const upd = await req.json().catch(() => ({}));
  try {
    await conversa(upd);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    // a pessoa pediu algo e nao veio nada: melhor avisar do que ficar mudo
    const chat = upd?.message?.chat?.id ?? upd?.callback_query?.message?.chat?.id;
    if (chat) await enviar(chat, "⚠️ Não consegui montar a resposta agora. Tente de novo em alguns minutos.").catch(() => {});
  }
  return json({ ok: true });
});
