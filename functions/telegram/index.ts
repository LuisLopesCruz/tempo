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
const enviar = (chat: number, texto: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id: chat, text: texto, parse_mode: "HTML",
                      disable_web_page_preview: true, ...extra });

async function segredoWebhook(): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("telegram:" + SEGREDO));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rpc(nome: string, args: Record<string, unknown> = {}) {
  const { data, error } = await sb.rpc(nome, args);
  if (error) throw new Error(`${nome}: ${error.message}`);
  return data;
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
  "/regioes — escolher as regiões que você acompanha\n" +
  "/parar — parar de receber avisos\n" +
  "/start — voltar a receber\n" +
  "/ajuda — esta mensagem\n\n" +
  "<b>Boletim</b> às 06h, 12h, 18h e 00h (este sem som): chance de chuva, acumulado, rajada, " +
  "risco elétrico e alertas oficiais, com os mesmos números do painel.\n" +
  "<b>Aviso imediato</b> (a qualquer hora, quando começa ou piora): trovoada se aproximando do " +
  "seu município (descargas da REDEMET, a cada 6 min), alerta laranja ou vermelho do INMET, " +
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

  if (d.startsWith("ap:") || d.startsWith("rc:")) {
    if (!u.admin) { await resp("Só o administrador aprova."); return; }
    const alvo = Number(d.slice(3));
    const ok = d.startsWith("ap:");
    const r = await rpc("tempo_tg_status", { p_chat: alvo, p_status: ok ? "ativo" : "recusado" });
    await resp(ok ? "Aprovado" : "Recusado");
    await tg("editMessageText", { chat_id: chat, message_id: q.message.message_id, parse_mode: "HTML",
      text: (ok ? "✅ Aprovado: " : "✖️ Recusado: ") + "<b>" + esc(r?.nome ?? String(alvo)) + "</b>" });
    if (ok) await enviar(alvo, "Seu acesso ao <b>TEMPO-RJ</b> foi aprovado! Escolha as regiões e toque em <b>Concluir</b>:",
                         { reply_markup: teclado([], false) });
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
type Mun = { nome: string; situacao: string; dist_km: number | null; chegada_em: string | null;
  vem_de?: string | null; velocidade_kmh?: number | null };
type Item = { regiao: string; tipo: string; silencioso: boolean; municipios: Mun[]; quadro: string };

function blocoRegiao(it: Item, comTitulo = true): string {
  const muns = it.municipios ?? [];
  const no = muns.filter((m) => m.situacao === "no_municipio");
  const cam = muns.filter((m) => m.situacao === "a_caminho");
  const futuro = (iso: string | null) => iso && new Date(iso).getTime() > Date.now();
  const lista = (ms: Mun[]) => ms.map((m) => esc(m.nome) + (m.situacao === "a_caminho" && m.dist_km != null
    ? ` (~${Math.round(m.dist_km)} km)` : "")).join(", ");
  if (it.tipo === "afastou") {
    return `✅ <b>Trovoada se afastou · ${esc(it.regiao)}</b>\nSem trovoada a até 50 km na última hora.`;
  }
  const chegadas = cam.map((m) => m.chegada_em).filter(futuro).sort() as string[];
  let s = "";
  if (it.tipo === "no_municipio") {
    s += `⚡⚡ <b>Trovoada no município · ${esc(it.regiao)}</b>\n${lista(no)}`;
    if (cam.length) s += `\nA caminho: ${lista(cam)}`;
  } else {
    s += `⚡ <b>Trovoada a caminho · ${esc(it.regiao)}</b>\n${lista(cam)}`;
    // rumo e velocidade do municipio mais proximo da trovoada (o primeiro da lista)
    const ref = cam.find((m) => m.vem_de);
    const mov = ref?.vem_de ? `vindo de ${ref.vem_de}` +
      (ref.velocidade_kmh ? ` a ~${Math.round(ref.velocidade_kmh)} km/h` : "") : "";
    const partes = [chegadas.length ? `Chegada estimada ~${hm(chegadas[0])}` : "", mov].filter(Boolean);
    if (partes.length) s += "\n" + partes.join(" · ");
  }
  return s;
}
const rodape = (quadro: string) => `\n<i>Descargas detectadas pela REDEMET · leitura das ${hm(quadro)}</i>`;

async function avisos() {
  const plano = (await rpc("tempo_tg_plano_trovoada")) as Item[];
  if (!plano.length) return { plano: 0, enviados: 0 };
  const dest = (await rpc("tempo_tg_destinatarios")) as { chat_id: number; regioes: string[]; todas: boolean }[];
  let enviados = 0;
  const quadro = plano[0].quadro;
  for (const d of dest) {
    const meus = d.todas ? plano : plano.filter((p) => d.regioes.includes(p.regiao));
    if (!meus.length) continue;
    // Quem segue varias regioes recebe UMA mensagem por rodada, nao uma por regiao.
    const texto = meus.map((p) => blocoRegiao(p)).join("\n\n") + rodape(quadro);
    const silencioso = meus.every((p) => p.silencioso);
    try {
      await enviar(d.chat_id, texto, { disable_notification: silencioso });
      enviados++;
      await rpc("tempo_tg_log", { p_chat: d.chat_id, p_tipo: "trovoada",
        p_regiao: meus.map((p) => p.regiao).join(","), p_ok: true, p_erro: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Pessoa que bloqueou o bot: para de tentar (senao erra a cada 6 min para sempre).
      if (/blocked|deactivated|chat not found/i.test(msg)) {
        await rpc("tempo_tg_status", { p_chat: d.chat_id, p_status: "parado" });
      }
      await rpc("tempo_tg_log", { p_chat: d.chat_id, p_tipo: "trovoada",
        p_regiao: meus.map((p) => p.regiao).join(","), p_ok: false, p_erro: msg.slice(0, 300) });
    }
  }
  return { plano: plano.length, enviados };
}

// ------------------------------------------------------------ avisos imediatos 2 a 5
// Formato aprovado pelo usuario em 07/11. A decisao de O QUE avisar (e a
// memoria do que ja foi dito) fica no banco: tempo_tg_plano_alertas.
type Alerta = { tipo: string; regiao: string; [k: string]: any };

function diaHora(iso: string): string {
  const t = new Date(new Date(iso).getTime() - 3 * 3_600_000), h = new Date(Date.now() - 3 * 3_600_000);
  const mesmo = t.toISOString().slice(0, 10) === h.toISOString().slice(0, 10);
  const dia = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][t.getUTCDay()];
  return (mesmo ? "" : `${dia} ${String(t.getUTCDate()).padStart(2, "0")}/${String(t.getUTCMonth() + 1).padStart(2, "0")} `) + hm(iso);
}
// O INMET manda os riscos como ["frase. Risco de ..."]: fica a primeira frase,
// que e a que diz o que vem (chuva de tanto, vento de tanto).
function resumoRiscos(r: string | null): string {
  if (!r) return "";
  let s = r.trim();
  if (s.startsWith("[")) { try { s = String(JSON.parse(s)[0] ?? ""); } catch { /* fica como veio */ } }
  s = s.split(/\.\s+(?=Risco|Baixo|Alto|Grande)/)[0].replace(/\.\s*$/, "").replace(/\s+/g, " ");
  return s ? s[0].toLowerCase() + s.slice(1) : "";
}
const lista = (xs: string[]) => xs.map(esc).join(", ");

function blocoAlerta(a: Alerta): string {
  if (a.tipo === "inmet") {
    const sev = a.severidade === "grande_perigo" ? ["🔴", "Grande Perigo"] : ["🟠", "Perigo"];
    const titulo = a.como === "elevou"
      ? `🔴 <b>INMET elevou para Grande Perigo · ${esc(a.descricao)} · ${esc(a.regiao)}</b>`
      : `${sev[0]} <b>INMET · ${esc(a.descricao)} — ${sev[1]} · ${esc(a.regiao)}</b>`;
    const comecou = new Date(a.inicio).getTime() <= Date.now();
    const quando = comecou ? `Até ${diaHora(a.fim)}` : `De ${diaHora(a.inicio)} até ${diaHora(a.fim)}`;
    const riscos = resumoRiscos(a.riscos);
    return `${titulo}\n${lista(a.municipios)}\n${quando}${riscos ? " · " + esc(riscos) : ""}`;
  }
  if (a.tipo === "dc") {
    const ROT: Record<string, string> = { geologico: "Risco geológico (deslizamentos)", hidrologico: "Risco hidrológico (enchentes)" };
    const linhas: string[] = [];
    for (const tipo of ["geologico", "hidrologico"]) {
      for (const nv of ["muito_alto", "alto"]) {
        const ms = a.itens.filter((i: any) => i.tipo === tipo && i.nivel === nv).map((i: any) => i.municipio);
        if (ms.length) linhas.push(`${ROT[tipo]} <b>${nv === "muito_alto" ? "MUITO ALTO" : "ALTO"}</b>: ${lista(ms)}`);
      }
      // moderado entra como contexto so quando e pouco (a fonte poe 80+ municipios em moderado)
      const mod = (a.moderados ?? []).filter((i: any) => i.tipo === tipo).map((i: any) => i.municipio);
      if (mod.length && mod.length <= 3) linhas.push(`${ROT[tipo]} <b>MODERADO</b>: ${lista(mod)}`);
    }
    return `🏔️ <b>Defesa Civil · ${esc(a.regiao)}</b>\n` + linhas.join("\n");
  }
  if (a.tipo === "risco") {
    return `🔌 <b>Risco elétrico ALTO ${a.quando} · ${esc(a.regiao)}</b>\n${lista(a.municipios)} · motivo: ${esc(a.motivo)}`;
  }
  if (a.tipo === "chuva") {
    const nf1 = (v: number) => Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
    return `🌧️ <b>Chuva forte medida · ${esc(a.regiao)}</b>\n` + a.itens.map((i: any) =>
      i.mm1h >= 30 ? `${esc(i.municipio)}: ${nf1(i.mm1h)} mm na última hora`
                   : `${esc(i.municipio)}: ${nf1(i.mm24)} mm em 24 h`).join("\n");
  }
  return "";
}

// Junta os blocos de uma pessoa em mensagens de ate ~3.800 caracteres (o
// limite do Telegram e 4.096).
function empacotar(blocos: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const b of blocos) {
    if (cur && cur.length + b.length + 2 > 3800) { out.push(cur); cur = ""; }
    cur = cur ? cur + "\n\n" + b : b;
  }
  if (cur) out.push(cur);
  return out;
}

async function alertas(soChat?: number) {
  const plano = ((await rpc("tempo_tg_plano_alertas")) as Alerta[])
    .sort((a, b) => REGIOES.indexOf(a.regiao) - REGIOES.indexOf(b.regiao));
  if (!plano.length) return { alertas: 0, enviados: 0 };
  const dest = (await rpc("tempo_tg_destinatarios")) as { chat_id: number; regioes: string[]; todas: boolean }[];
  let enviados = 0;
  for (const d of dest) {
    if (soChat && d.chat_id !== soChat) continue;
    const meus = d.todas ? plano : plano.filter((p) => d.regioes.includes(p.regiao));
    for (const texto of empacotar(meus.map(blocoAlerta).filter(Boolean))) {
      try {
        await enviar(d.chat_id, texto);
        enviados++;
        await rpc("tempo_tg_log", { p_chat: d.chat_id, p_tipo: "alerta", p_regiao: null, p_ok: true, p_erro: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await rpc("tempo_tg_log", { p_chat: d.chat_id, p_tipo: "alerta", p_regiao: null, p_ok: false, p_erro: msg.slice(0, 300) });
        if (/blocked|deactivated|chat not found/i.test(msg)) {
          await rpc("tempo_tg_status", { p_chat: d.chat_id, p_status: "parado" });
          break;
        }
      }
    }
  }
  return { alertas: plano.length, enviados };
}

// Trovoada e os demais avisos na mesma rodada; um tipo falhar nao derruba o outro.
async function avisosTodos() {
  const r: Record<string, unknown> = {};
  try { Object.assign(r, await avisos()); } catch (e) { r.erro_trovoada = e instanceof Error ? e.message : String(e); }
  try { const x = await alertas(); r.alertas = x.alertas; r.enviados = ((r.enviados as number) ?? 0) + x.enviados; }
  catch (e) { r.erro_alertas = e instanceof Error ? e.message : String(e); }
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
  normal_mes: number | null; risco_hoje: string | null; risco_amanha: string | null };
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
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
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
// cobre todo o resto, vira "demais" (como no modelo aprovado).
function linhasRisco(ms: MunB[]): string[] {
  const nv = (m: MunB) => (m.risco_hoje && RISCO[m.risco_hoje]) ? m.risco_hoje : null;
  const presentes = ["alto", "elevado", "moderado", "normal"].filter((k) => ms.some((m) => nv(m) === k));
  if (!presentes.length) return ["sem cálculo para hoje"];
  if (presentes.length === 1) return [`${RISCO[presentes[0]][0]} ${RISCO[presentes[0]][1]}: todos os municípios`];
  return presentes.map((k, i) => `${RISCO[k][0]} ${RISCO[k][1]}: ` + (i === presentes.length - 1 ? "demais"
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
    if (medMes) L.push(`No mês: ${nf(medMes.mm_mes!, 0)} mm = <b>${pctMes(medMes.mm_mes, medMes.normal_mes)} do previsto para o mês</b>`);
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
async function boletim(soChat?: number) {
  const regs = ((await rpc("tempo_tg_boletim")) as RegB[])
    .sort((a, b) => REGIOES.indexOf(a.regiao) - REGIOES.indexOf(b.regiao));
  const dest = (await rpc("tempo_tg_destinatarios")) as { chat_id: number; regioes: string[]; todas: boolean }[];
  const agora = new Date(Date.now() - 3 * 3_600_000);
  const meiaNoite = agora.getUTCHours() < 3;                 // o das 00h sai todo sem som
  const rotuloHora = soChat ? hm(new Date().toISOString())   // pedido na hora: hora exata
    : String(Math.round(agora.getUTCHours() + agora.getUTCMinutes() / 60) % 24).padStart(2, "0") + "h";
  let enviados = 0;
  for (const d of dest) {
    if (soChat && d.chat_id !== soChat) continue;
    const meus = d.todas ? regs : regs.filter((r) => d.regioes.includes(r.regiao));
    for (let i = 0; i < meus.length; i++) {
      try {
        await enviar(d.chat_id, cardRegiao(meus[i], rotuloHora),
                     { disable_notification: (meiaNoite && !soChat) || i > 0 });
        enviados++;
        await rpc("tempo_tg_log", { p_chat: d.chat_id, p_tipo: "boletim", p_regiao: meus[i].regiao, p_ok: true, p_erro: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await rpc("tempo_tg_log", { p_chat: d.chat_id, p_tipo: "boletim", p_regiao: meus[i].regiao, p_ok: false, p_erro: msg.slice(0, 300) });
        if (/blocked|deactivated|chat not found/i.test(msg)) {
          await rpc("tempo_tg_status", { p_chat: d.chat_id, p_status: "parado" });
          break;
        }
      }
    }
  }
  return { regioes: regs.length, enviados };
}

// ------------------------------------------------------------ /boletim de um municipio
// Pedido do usuario em 08/11: escolher UM municipio e receber na hora a "foto
// do que esta no site" para ele. Escolha em dois passos (regiao -> municipio):
// 92 botoes numa lista so seriam impraticaveis no celular. Ou digitado:
// "/boletim Petropolis", com ou sem acento.
type MunInfo = { ibge: number; nome: string; regiao: string };
const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function tecladoRegioesMun() {
  const linhas: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < REGIOES.length; i += 2) {
    linhas.push(REGIOES.slice(i, i + 2).map((r, k) => ({ text: r, callback_data: "b:r:" + (i + k) })));
  }
  return { inline_keyboard: linhas };
}
function tecladoMunicipios(muns: MunInfo[]) {
  const linhas: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < muns.length; i += 2) {
    linhas.push(muns.slice(i, i + 2).map((m) => ({ text: m.nome, callback_data: "b:m:" + m.ibge })));
  }
  linhas.push([{ text: "← Regiões", callback_data: "b:mun" }]);
  return { inline_keyboard: linhas };
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
      const partes = [`🟠 <b>A caminho</b>: a ${km(t.dist_km)}`];
      if (t.chegada_em && new Date(t.chegada_em).getTime() > Date.now()) partes.push(`chegada ~${hm(t.chegada_em)}`);
      if (t.vem_de) partes.push(`vindo de ${t.vem_de}` + (t.velocidade_kmh ? ` a ~${Math.round(t.velocidade_kmh)} km/h` : ""));
      return partes.join(" · ");
    }
    case "perto": return `🟡 <b>Por perto</b>: a ${t.dist_km != null && t.dist_km <= 50 ? km(t.dist_km) : "até 50 km"}, sem se aproximar`;
    case "sem_dado": return "⚪ Sem leitura recente da REDEMET";
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
      L.push(`No mês: ${nf(m.mm_mes, 0)} mm = <b>${pctMes(m.mm_mes, m.normal_mes)} do previsto para o mês</b>`);
    }
  }
  const rv = (n: string | null) => n && RISCO[n] ? `${RISCO[n][0]} ${RISCO[n][1]}` : "sem cálculo";
  L.push("", "⚡ <b>Risco elétrico</b>", `Hoje: ${rv(m.risco_hoje)} · Amanhã: ${rv(m.risco_amanha)}`);
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
  L.push("", "<i>detalhes em tempo-rj.vercel.app</i>");
  return L.join("\n");
}

async function boletimMunicipio(chat: number, ibge: number) {
  const m = await rpc("tempo_tg_municipio", { p_ibge: ibge });
  if (!m) { await enviar(chat, "Não encontrei esse município."); return; }
  await enviar(chat, cardMunicipio(m));
  await rpc("tempo_tg_log", { p_chat: chat, p_tipo: "boletim_municipio", p_regiao: m.regiao, p_ok: true, p_erro: null });
}

// "/boletim <nome>": acha o municipio pelo nome, sem acento e sem caixa.
async function buscarMunicipio(chat: number, termo: string) {
  const todos = (await rpc("tempo_tg_municipios")) as MunInfo[];
  const t = semAcento(termo);
  const exato = todos.filter((m) => semAcento(m.nome) === t);
  const achados = exato.length ? exato : todos.filter((m) => semAcento(m.nome).includes(t));
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

// ------------------------------------------------------------ configurar (1 vez)
async function configurar() {
  const eu = await tg("getMe", {});
  const url = Deno.env.get("SUPABASE_URL") + "/functions/v1/tempo-telegram";
  await tg("setWebhook", { url, secret_token: await segredoWebhook(),
                           allowed_updates: ["message", "callback_query"],
                           drop_pending_updates: false });   // o /start que ja esta na fila vale
  await tg("setMyCommands", { commands: [
    { command: "boletim", description: "Boletim agora: um município ou suas regiões" },
    { command: "regioes", description: "Escolher as regiões que você acompanha" },
    { command: "parar", description: "Parar de receber avisos" },
    { command: "start", description: "Voltar a receber avisos" },
    { command: "ajuda", description: "Como o bot funciona" },
  ] });
  await tg("setMyDescription", { description:
    "Tempo no estado do Rio de Janeiro, por região: boletim de 6 em 6 h com os números do painel " +
    "TEMPO-RJ e avisos imediatos — trovoada se aproximando, alertas do INMET e da Defesa Civil, " +
    "risco elétrico e chuva forte medida. Acesso mediante aprovação." });
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
              : acao === "teste_alertas" ? await alertas(((await rpc("tempo_tg_admins")) as number[])[0])
              : await avisosTodos();
      if (acao !== "configurar" && !acao.startsWith("teste")) {
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
  try {
    await conversa(await req.json());
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
  }
  return json({ ok: true });
});
