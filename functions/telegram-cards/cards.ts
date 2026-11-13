// ============================================================================
// TEMPO-RJ — cards em IMAGEM para o Telegram (teste pedido pelo usuario, 13/11)
// ----------------------------------------------------------------------------
// "Quero facilitar a leitura... a imagem da para copiar e compartilhar."
// O Telegram nao deixa colorir texto; numa imagem a cor e livre. Aqui so se
// MONTA a arvore de elementos (no formato que o satori le); quem desenha e o
// index.ts (satori -> SVG -> resvg -> PNG). Sem dependencia nenhuma, para o
// mesmo arquivo rodar no Deno (Supabase) e no Node (teste local).
//
// Cores = as do painel (web/index.html). Em faixa de titulo, laranja e verde
// ficam um tom mais escuros para o texto branco continuar legivel.
// ============================================================================

export const W = 1080;
const PAD = 56;
const CW = W - 2 * PAD;

export const C = {
  plane: "#f9f9f7", surface: "#ffffff", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", grid: "#e1e0d9",
  good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b", accent: "#2a78d6", raio: "#7c3aed",
  laranja: "#d9622b", verde: "#0f8a0f", azul: "#1f62b8",
};

// ------------------------------------------------------------------ base
type No = { type: string; props: Record<string, unknown> };
type Peca = [No, number];               // elemento + altura estimada (px)

function el(type: string, style: Record<string, unknown>, ...filhos: unknown[]): No {
  const c = filhos.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false && x !== "");
  return { type, props: { style: { display: "flex", ...style }, children: c.length === 1 ? c[0] : c } };
}
const div = (style: Record<string, unknown>, ...f: unknown[]) => el("div", style, ...f);

// O satori exige altura fixa. Estima-se o numero de linhas de cada texto pela
// largura media dos caracteres da Inter; sobra um pouco no fim do card.
function nLinhas(t: string, fs: number, w: number, peso = 400): number {
  const cw = fs * (peso >= 700 ? 0.58 : peso >= 600 ? 0.56 : 0.53);
  const cabe = Math.max(1, Math.floor(w / cw));
  let n = 0;
  for (const par of String(t).split("\n")) {
    let l = 1, cur = 0;
    for (const p of par.split(" ")) {
      const len = p.length + 1;
      if (cur > 0 && cur + len > cabe) { l++; cur = len; } else cur += len;
    }
    n += l;
  }
  return n;
}
function texto(t: string, o: { fs: number; w: number; peso?: number; cor?: string; lh?: number;
                               ls?: number; caixa?: boolean; extra?: Record<string, unknown> }): Peca {
  const lh = o.lh ?? 1.32, peso = o.peso ?? 400;
  const s = o.caixa ? String(t).toUpperCase() : String(t);
  const h = Math.ceil(nLinhas(s, o.fs, o.w, peso) * o.fs * lh);
  return [div({ width: o.w, fontSize: o.fs, fontWeight: peso, color: o.cor ?? C.ink, lineHeight: lh,
                letterSpacing: o.ls ?? 0, flexWrap: "wrap", ...(o.extra ?? {}) }, s), h];
}
function coluna(pecas: Peca[], gap = 0, style: Record<string, unknown> = {}): Peca {
  const ps = pecas.filter(Boolean);
  return [div({ flexDirection: "column", ...style, gap }, ps.map((p) => p[0])),
          ps.reduce((a, p) => a + p[1], 0) + gap * Math.max(0, ps.length - 1)];
}
function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
export const nf = (v: number, c = 1) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c });

// ------------------------------------------------------------------ icones (SVG proprio, sem emoji)
const ICONES: Record<string, string> = {
  raio: '<polygon points="13,2 4,14 11,14 10,22 20,9 13,9" fill="COR"/>',
  check: '<polyline points="5,12.5 10,17.5 19,7" fill="none" stroke="COR" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>',
  tomada: '<path d="M8 3v5M16 3v5M5 8h14v3a7 7 0 0 1-14 0zM12 18v4" fill="none" stroke="COR" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  alerta: '<path d="M12 3 2 20h20z" fill="COR"/><rect x="11" y="9" width="2" height="6" fill="FUNDO"/><rect x="11" y="16.5" width="2" height="2" fill="FUNDO"/>',
  montanha: '<path d="M2 20 9 7l4 6 3-4 6 11z" fill="COR"/>',
  onda: '<path d="M2 9c3-3 5 3 8 0s5 3 8 0 3-1 4-1M2 15c3-3 5 3 8 0s5 3 8 0 3-1 4-1" fill="none" stroke="COR" stroke-width="2.4" stroke-linecap="round"/>',
  chuva: '<path d="M7 14a5 5 0 1 1 1.5-9.8A6 6 0 0 1 19 8a4 4 0 0 1-1 7.9H7z" fill="COR"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3" stroke="COR" stroke-width="2" stroke-linecap="round"/>',
  nuvem: '<path d="M7 18a5 5 0 1 1 1.5-9.8A6 6 0 0 1 19 12a4 4 0 0 1-1 7.9H7z" fill="COR"/><circle cx="16.5" cy="6" r="3" fill="none" stroke="COR" stroke-width="1.8"/>',
  pino: '<path d="M12 22s7-7.2 7-12a7 7 0 0 0-14 0c0 4.8 7 12 7 12z" fill="COR"/><circle cx="12" cy="10" r="2.6" fill="FUNDO"/>',
};
function icone(nome: string, cor: string, fundo: string, tam: number): No {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${tam}" height="${tam}">` +
    ICONES[nome].replaceAll("COR", cor).replaceAll("FUNDO", fundo) + "</svg>";
  return { type: "img", props: { src: "data:image/svg+xml;base64," + btoa(svg), width: tam, height: tam,
                                 style: { width: tam, height: tam } } };
}

// ------------------------------------------------------------------ pecas comuns
function cabecalho(o: { cor: string; claro?: boolean; icone: string; kicker: string; titulo: string; sub?: string }): Peca {
  const tc = o.claro ? C.ink : "#ffffff";
  const wTxt = CW - 120 - 32;
  const k = texto(o.kicker, { fs: 26, w: wTxt, peso: 600, cor: tc, ls: 1.5, caixa: true, extra: { opacity: 0.88 } });
  const t = texto(o.titulo, { fs: 58, w: wTxt, peso: 800, cor: tc, lh: 1.08 });
  const s = o.sub ? texto(o.sub, { fs: 30, w: wTxt, peso: 400, cor: tc, extra: { opacity: 0.92 } }) : null;
  const col = coluna([k, t, ...(s ? [s] : [])], 10);
  const h = Math.max(120, col[1]) + 2 * 46;
  return [div({ backgroundColor: o.cor, padding: `46px ${PAD}px`, alignItems: "center", gap: 32, width: W },
              div({ width: 120, height: 120, borderRadius: 60, backgroundColor: o.claro ? C.ink : "#ffffff",
                    alignItems: "center", justifyContent: "center", flexShrink: 0 },
                  icone(o.icone, o.claro ? "#ffffff" : o.cor, o.claro ? C.ink : "#ffffff", 72)),
              col[0]), h];
}

function secao(rotulo: string, corpo: string, cor = C.muted): Peca {
  const r = texto(rotulo, { fs: 23, w: CW, peso: 700, cor, ls: 2, caixa: true });
  const t = texto(corpo, { fs: 34, w: CW, peso: 400, cor: C.ink });
  const c = coluna([r, t], 8);
  return [div({ flexDirection: "column", borderTop: `2px solid ${C.grid}`, padding: "24px 0" }, c[0]), c[1] + 48 + 2];
}

function caixaFazer(t: string, cor: string): Peca {
  const r = texto("O que fazer", { fs: 23, w: CW - 64, peso: 700, cor, ls: 2, caixa: true });
  const x = texto(t, { fs: 34, w: CW - 64, peso: 600, cor: C.ink });
  const c = coluna([r, x], 8);
  return [div({ flexDirection: "column", backgroundColor: rgba(cor, 0.10), borderLeft: `10px solid ${cor}`,
                borderRadius: 14, padding: "26px 26px 26px 28px", marginTop: 8 }, c[0]), c[1] + 52 + 8];
}

// linha de destaque: nome + detalhe a esquerda, numero grande a direita
function linhaDestaque(nome: string, detalhe: string | null, valor: string | null, rotuloValor: string | null, cor: string): Peca {
  const wEsq = valor ? CW - 64 - 260 : CW - 64;
  const n = texto(nome, { fs: 40, w: wEsq, peso: 700 });
  const d = detalhe ? texto(detalhe, { fs: 28, w: wEsq, cor: C.ink2 }) : null;
  const esq = coluna([n, ...(d ? [d] : [])], 4);
  const dir = valor ? coluna([texto(valor, { fs: 64, w: 260, peso: 800, cor, lh: 1, extra: { justifyContent: "flex-end" } }),
                             ...(rotuloValor ? [texto(rotuloValor, { fs: 22, w: 260, cor: C.ink2, lh: 1.2,
                                                                     extra: { justifyContent: "flex-end", textAlign: "right" } })] : [])], 4)
                    : null;
  const h = Math.max(esq[1], dir ? dir[1] : 0) + 2 * 22;
  return [div({ backgroundColor: C.surface, border: `2px solid ${C.grid}`, borderRadius: 18, padding: "22px 30px",
                alignItems: "center", justifyContent: "space-between", width: CW },
              esq[0], dir ? dir[0] : null), h + 4];
}

// escala de niveis (INMET 3, risco eletrico 4, Defesa Civil 5)
function escala(niveis: [string, string][], atual: number, titulo: string): Peca {
  const n = niveis.length, gap = 10, w = Math.floor((CW - gap * (n - 1)) / n);
  const t = texto(titulo, { fs: 23, w: CW, peso: 700, cor: C.muted, ls: 2, caixa: true });
  const barras = div({ gap, width: CW, alignItems: "flex-end" }, niveis.map(([nome, cor], i) =>
    div({ flexDirection: "column", width: w, gap: 8 },
        div({ height: i === atual ? 30 : 16, borderRadius: 8, backgroundColor: i === atual ? cor : rgba(cor, 0.30), width: w }),
        div({ fontSize: i === atual ? 28 : 22, fontWeight: i === atual ? 800 : 400, color: i === atual ? C.ink : C.muted,
              justifyContent: "center", width: w }, i === atual ? nome.toUpperCase() : nome))));
  return [div({ flexDirection: "column", gap: 14, padding: "8px 0 26px 0" }, t[0], barras), t[1] + 14 + 30 + 8 + 36 + 34];
}

function rodape(origem: string, quando: string, teste: boolean): Peca {
  const o = texto("Origem: " + origem, { fs: 24, w: CW, cor: C.ink2 });
  const barra = div({ justifyContent: "space-between", alignItems: "center", width: CW, borderTop: `2px solid ${C.grid}`,
                      paddingTop: 22 },
    div({ alignItems: "center", gap: 12 },
        div({ fontSize: 28, fontWeight: 800, color: C.accent }, "TEMPO-RJ"),
        div({ fontSize: 24, color: C.ink2 }, "tempo-rj.vercel.app")),
    div({ alignItems: "center", gap: 14 },
        teste ? div({ fontSize: 20, fontWeight: 800, color: "#ffffff", backgroundColor: C.raio, borderRadius: 8,
                      padding: "6px 12px", letterSpacing: 1.5 }, "EXEMPLO DE TESTE") : null,
        div({ fontSize: 24, color: C.ink2 }, quando)));
  return [div({ flexDirection: "column", gap: 22, marginTop: 18 }, o[0], barra), o[1] + 22 + 22 + 40 + 18];
}

function montar(topo: Peca, corpo: Peca[], fim: Peca): { no: No; altura: number } {
  const c = coluna(corpo, 0);
  const h = topo[1] + 36 + c[1] + fim[1] + 50 + 24;   // 24 = folga da estimativa
  return {
    no: div({ flexDirection: "column", width: W, height: h, backgroundColor: C.plane, fontFamily: "Inter" },
            topo[0],
            div({ flexDirection: "column", padding: `36px ${PAD}px 50px ${PAD}px`, flexGrow: 1 }, c[0], fim[0])),
    altura: h,
  };
}

// ------------------------------------------------------------------ AVISOS (tipos 3 a 11)
export type Aviso = {
  cor: string; claro?: boolean; icone: string; kicker: string; titulo: string; sub?: string;
  destaque?: { nome: string; detalhe?: string; valor?: string; rotulo?: string }[];
  corDestaque?: string;
  escala?: { niveis: [string, string][]; atual: number; titulo: string };
  secoes: [string, string][]; fazer?: string; origem: string; quando: string; teste?: boolean;
};
export function cardAviso(a: Aviso) {
  const corpo: Peca[] = [];
  if (a.escala) corpo.push(escala(a.escala.niveis, a.escala.atual, a.escala.titulo));
  if (a.destaque?.length) {
    const ls = a.destaque.map((d) => linhaDestaque(d.nome, d.detalhe ?? null, d.valor ?? null, d.rotulo ?? null, a.corDestaque ?? a.cor));
    const c = coluna(ls, 14);
    corpo.push([div({ flexDirection: "column", gap: 14, paddingBottom: 26 }, ls.map((l) => l[0])), c[1] + 26]);
  }
  for (const [r, t] of a.secoes) corpo.push(secao(r, t));
  if (a.fazer) corpo.push(caixaFazer(a.fazer, a.cor));
  return montar(cabecalho(a), corpo, rodape(a.origem, a.quando, !!a.teste));
}

// ------------------------------------------------------------------ BOLETINS (tipos 1 e 2)
type MunB = { municipio: string; k6: number; chance6: number | null; k_forte: number; mm24: number | null;
  p25_24: number | null; p75_24: number | null; raj24: number | null; tmax: number | null; tmin: number | null;
  mm_hoje: number | null; mm_mes: number | null; normal_mes: number | null; risco_hoje: string | null;
  risco_amanha?: string | null; risco_hoje_p: number | null; risco_amanha_p?: number | null };

const RISCO: Record<string, [string, string]> = {
  alto: ["Alto", C.critical], elevado: ["Elevado", C.laranja], moderado: ["Moderado", "#c98a00"], normal: ["Normal", C.muted] };
const SEV: Record<string, [string, string, number]> = {
  perigo_potencial: ["Amarelo", C.warning, 1], perigo: ["Laranja", C.laranja, 2], grande_perigo: ["Vermelho", C.critical, 3] };
const DC_NV: Record<string, [string, string]> = {
  muito_baixo: ["muito baixo", C.good], baixo: ["baixo", C.good], moderado: ["moderado", C.warning],
  alto: ["alto", C.laranja], muito_alto: ["muito alto", C.critical] };

function pior<T>(xs: T[], v: (x: T) => number | null | undefined): T | null {
  let m: T | null = null, mv = -Infinity;
  for (const x of xs) { const y = v(x); if (y != null && y > mv) { mv = y; m = x; } }
  return m;
}
const pctMes = (mm: number | null | undefined, normal: number | null | undefined) => {
  if (!normal || mm == null) return "–";
  const p = 100 * mm / normal;
  return p > 0 && p < 1 ? "menos de 1%" : `${Math.round(p)}%`;
};

function bloco(rotulo: string, filhos: Peca[], gap = 12): Peca {
  const r = texto(rotulo, { fs: 23, w: CW, peso: 700, cor: C.muted, ls: 2, caixa: true });
  const c = coluna([r, ...filhos], gap);
  return [div({ flexDirection: "column", borderTop: `2px solid ${C.grid}`, padding: "24px 0", gap }, [r[0], ...filhos.map((f) => f[0])]),
          c[1] + 48 + 2];
}
function ladrilho(w: number, rotulo: string, valor: string, sub: string, cor = C.ink): Peca {
  const r = texto(rotulo, { fs: 22, w: w - 56, peso: 700, cor: C.muted, ls: 1.5, caixa: true });
  const v = texto(valor, { fs: 62, w: w - 56, peso: 800, cor, lh: 1.05 });
  const s = texto(sub, { fs: 26, w: w - 56, cor: C.ink2, lh: 1.3 });
  const c = coluna([r, v, s], 8);
  return [div({ flexDirection: "column", width: w, backgroundColor: C.surface, border: `2px solid ${C.grid}`,
                borderRadius: 18, padding: 26, gap: 8 }, [r[0], v[0], s[0]]), c[1] + 52 + 4];
}
function par(a: Peca, b: Peca): Peca {
  const h = Math.max(a[1], b[1]);
  return [div({ gap: 20, width: CW, alignItems: "stretch", marginBottom: 20 }, a[0], b[0]), h + 20];
}
function barraMes(mm: number, normal: number): Peca {
  const p = Math.max(0, mm / normal);
  const cheio = Math.min(1, p);
  const t1 = texto(`Acumulado ${nf(mm, 0)} mm de ${nf(normal, 0)} mm previstos para o mês`, { fs: 30, w: CW - 170 });
  return [div({ flexDirection: "column", gap: 12, width: CW },
              div({ justifyContent: "space-between", alignItems: "flex-end", width: CW },
                  t1[0], div({ fontSize: 48, fontWeight: 800, color: C.azul }, pctMes(mm, normal))),
              div({ width: CW, height: 22, borderRadius: 11, backgroundColor: C.grid },
                  div({ width: Math.max(22, Math.round(CW * cheio)), height: 22, borderRadius: 11, backgroundColor: C.azul }))),
          Math.max(t1[1], 56) + 12 + 22];
}
function pilula(txt: string, cor: string, claro = false): No {
  return div({ fontSize: 24, fontWeight: 800, color: claro ? C.ink : "#ffffff", backgroundColor: cor, borderRadius: 10,
               padding: "6px 14px", letterSpacing: 1 }, txt.toUpperCase());
}
function linhaRisco(nivel: string, chance: string, quem: string): Peca {
  const [nome, cor] = RISCO[nivel] ?? [nivel, C.muted];
  const q = texto(quem, { fs: 30, w: CW, cor: C.ink });
  return [div({ flexDirection: "column", gap: 8, width: CW },
              div({ alignItems: "center", gap: 14 }, pilula(nome, cor, nivel === "moderado"),
                  div({ fontSize: 28, color: C.ink2 }, chance)), q[0]), 44 + 8 + q[1]];
}
function linhaPonto(cor: string, t: string): Peca {
  const x = texto(t, { fs: 30, w: CW - 40 });
  return [div({ gap: 18, alignItems: "flex-start", width: CW },
              div({ width: 22, height: 22, borderRadius: 11, backgroundColor: cor, marginTop: 9, flexShrink: 0 }), x[0]), x[1]];
}
const ate = (iso: string | null) => {
  if (!iso) return "";
  const t = new Date(new Date(iso).getTime() - 3 * 3_600_000), h = new Date(Date.now() - 3 * 3_600_000);
  const hh = String(t.getUTCHours()).padStart(2, "0") + "h" + String(t.getUTCMinutes()).padStart(2, "0");
  return " até " + (t.toISOString().slice(0, 10) === h.toISOString().slice(0, 10) ? hh + " de hoje"
    : `${String(t.getUTCDate()).padStart(2, "0")}/${String(t.getUTCMonth() + 1).padStart(2, "0")} ${hh}`);
};
function alertasInmet(inmet: { descricao: string; severidade: string; fim: string | null }[]): Peca[] {
  const por = new Map<string, typeof inmet[0]>();
  for (const a of inmet ?? []) {
    const at = por.get(a.descricao);
    if (!at || (SEV[a.severidade]?.[2] ?? 0) > (SEV[at.severidade]?.[2] ?? 0)) por.set(a.descricao, a);
  }
  return [...por.values()].sort((a, b) => (SEV[b.severidade]?.[2] ?? 0) - (SEV[a.severidade]?.[2] ?? 0))
    .map((a) => linhaPonto(SEV[a.severidade]?.[1] ?? C.muted,
      `INMET · ${a.descricao} (${(SEV[a.severidade]?.[0] ?? "").toLowerCase()})${ate(a.fim)}`));
}
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function blocosPrevisao(p6: MunB, kf: number, mm: MunB, raj: number, tmin: number, tmax: number): Peca[] {
  const w2 = (CW - 20) / 2;
  const chance = p6.chance6 != null ? `${nf(100 * p6.chance6)}%` : "–";
  const corCh = (p6.chance6 ?? 0) >= 0.5 ? C.azul : C.ink;
  return [
    par(ladrilho(w2, "Próximas 6 h", chance, `de chance de chover · ${p6.k6} de 8 famílias de modelos preveem chuva`, corCh),
        ladrilho(w2, "Próximas 24 h", `~${nf(mm.mm24 ?? 0)} mm`,
                 (mm.p25_24 != null && mm.p75_24 != null ? `faixa provável ${nf(mm.p25_24)}–${nf(mm.p75_24)} mm · ` : "") +
                 `chuva forte em ${kf} de 8 famílias`)),
    par(ladrilho(w2, "Rajada máxima", `${Math.round(raj)} km/h`, "próximas 24 h", raj >= 60 ? C.laranja : C.ink),
        ladrilho(w2, "Temperatura", `${Math.round(tmin)}–${Math.round(tmax)} °C`, "mínima e máxima")),
  ];
}

export function cardBoletimRegiao(r: { regiao: string; muns: MunB[]; inmet: any[]; dc: { tipo: string; nivel: string; muns: string[] }[] },
                                  rotulo: string, quando: string) {
  const ms = r.muns ?? [];
  const p6 = pior(ms, (m) => m.chance6) ?? ms[0];
  const kf = Math.max(0, ...ms.map((m) => m.k_forte ?? 0));
  const mm = pior(ms, (m) => m.mm24) ?? ms[0];
  const raj = Math.max(0, ...ms.map((m) => m.raj24 ?? 0));
  const tmax = Math.max(...ms.map((m) => m.tmax ?? -99)), tmin = Math.min(...ms.map((m) => m.tmin ?? 99));
  const medHoje = pior(ms, (m) => m.mm_hoje);
  const medMes = pior(ms, (m) => (m.mm_mes != null && m.normal_mes ? m.mm_mes / m.normal_mes : null));

  const corpo: Peca[] = [...blocosPrevisao(p6, kf, mm, raj, tmin, tmax)];
  const med: Peca[] = [];
  if (!medHoje && !medMes) med.push(texto("Sem pluviômetro com leitura nesta região.", { fs: 30, w: CW, cor: C.ink2 }));
  else {
    med.push(texto(`Hoje até agora: ${nf(medHoje?.mm_hoje ?? 0)} mm` +
                   (medHoje?.normal_mes ? ` (${pctMes(medHoje.mm_hoje, medHoje.normal_mes)} do previsto para o mês)` : ""),
                   { fs: 30, w: CW }));
    if (medMes) med.push(barraMes(medMes.mm_mes!, medMes.normal_mes!));
  }
  corpo.push(bloco("Chuva medida", med, 16));

  const nv = (m: MunB) => (m.risco_hoje && RISCO[m.risco_hoje]) ? m.risco_hoje : null;
  const pres = ["alto", "elevado", "moderado", "normal"].filter((k) => ms.some((m) => nv(m) === k));
  const ch = (k: string) => {
    const v = ms.filter((m) => nv(m) === k).map((m) => m.risco_hoje_p).filter((p): p is number => p != null).map((p) => Math.round(100 * p));
    if (!v.length) return "";
    const mx = Math.max(...v), mn = Math.min(...v);
    return `${mx === mn ? "" : "até "}${mx}% de chance de dia ruim`;
  };
  corpo.push(bloco("Risco de falta de energia hoje", pres.length === 0 ? [texto("sem cálculo para hoje", { fs: 30, w: CW })]
    : pres.map((k, i) => linhaRisco(k, ch(k), pres.length === 1 ? "todos os municípios"
        : i === pres.length - 1 ? "demais municípios" : ms.filter((m) => nv(m) === k).map((m) => m.municipio).join(", "))), 18));

  const al = alertasInmet(r.inmet);
  for (const d of r.dc ?? []) al.push(linhaPonto((DC_NV[d.nivel] ?? ["", C.laranja])[1],
    `Defesa Civil · risco ${d.tipo === "geologico" ? "de deslizamento" : "de enchente"} ${(DC_NV[d.nivel] ?? [d.nivel])[0]}: ${d.muns.join(", ")}`));
  corpo.push(bloco("Alertas em vigor", al.length ? al : [texto("nenhum", { fs: 30, w: CW, cor: C.ink2 })], 14));

  return montar(cabecalho({ cor: C.accent, icone: "nuvem", kicker: `Boletim das ${rotulo} · ${quando.split(" ")[0]}`,
                            titulo: r.regiao, sub: `${ms.length} municípios · o pior número de cada item` }),
                corpo, rodape("previsão das 8 famílias de modelos do TEMPO-RJ, pluviômetros do CEMADEN e Alerta Rio, modelo de impacto (ANEEL), INMET e Defesa Civil.", quando, false));
}

export function cardBoletimMunicipio(m: MunB & { regiao: string; trovoada: any; inmet: any[]; dc: { tipo: string; nivel: string }[] },
                                     quando: string) {
  const corpo: Peca[] = [...blocosPrevisao(m, m.k_forte, m, m.raj24 ?? 0, m.tmin ?? 0, m.tmax ?? 0)];
  const med: Peca[] = [];
  if (m.mm_mes == null && m.mm_hoje == null) med.push(texto("Sem pluviômetro com leitura neste município.", { fs: 30, w: CW, cor: C.ink2 }));
  else {
    med.push(texto(`Hoje até agora: ${nf(m.mm_hoje ?? 0)} mm` + (m.normal_mes ? ` (${pctMes(m.mm_hoje, m.normal_mes)} do previsto para o mês)` : ""), { fs: 30, w: CW }));
    if (m.mm_mes != null && m.normal_mes) med.push(barraMes(m.mm_mes, m.normal_mes));
  }
  corpo.push(bloco("Chuva medida", med, 16));
  const rv = (n: string | null | undefined, p: number | null | undefined, dia: string): Peca => {
    const [nome, cor] = RISCO[n ?? ""] ?? ["sem cálculo", C.muted];
    return [div({ alignItems: "center", gap: 16, width: CW },
                div({ fontSize: 30, fontWeight: 700, width: 130 }, dia),
                pilula(nome, cor, n === "moderado"),
                div({ fontSize: 28, color: C.ink2 }, p != null ? `${Math.round(100 * p)}% de chance de dia ruim` : "")), 46];
  };
  corpo.push(bloco("Risco de falta de energia", [rv(m.risco_hoje, m.risco_hoje_p, "Hoje"), rv(m.risco_amanha, m.risco_amanha_p, "Amanhã")], 18));

  const t = m.trovoada;
  const LADO: Record<string, string> = { norte: "ao norte", sul: "ao sul", leste: "a leste", oeste: "a oeste",
    nordeste: "a nordeste", noroeste: "a noroeste", sudeste: "a sudeste", sudoeste: "a sudoeste" };
  const tv: Peca = !t ? linhaPonto(C.muted, "sem leitura da REDEMET")
    : t.situacao === "no_municipio" ? linhaPonto(C.critical, "Sobre o município: descargas a até 10 km nos últimos 20 min")
    : t.situacao === "a_caminho" ? linhaPonto(C.laranja, `Próxima: a ~${Math.round(t.dist_km ?? 0)} km${t.vem_de ? " " + (LADO[t.vem_de] ?? "") : ""}` +
                                              (t.chance != null ? ` · ${Math.round(100 * t.chance)}% de chance de chegar` : ""))
    : t.situacao === "perto" ? linhaPonto(C.warning, `Por perto: a ~${Math.round(t.dist_km ?? 50)} km, sem ameaça imediata`)
    : linhaPonto(C.good, "Sem trovoada a até 50 km");
  corpo.push(bloco("Trovoada agora", [tv], 14));

  const al = alertasInmet(m.inmet);
  if (!al.length) al.push(linhaPonto(C.good, "INMET: nenhum aviso"));
  for (const tipo of ["hidrologico", "geologico"]) {
    const d = (m.dc ?? []).find((x) => x.tipo === tipo);
    const [nome, cor] = d ? (DC_NV[d.nivel] ?? [d.nivel, C.muted]) : ["sem dado", C.muted];
    al.push(linhaPonto(cor, `Defesa Civil · risco ${tipo === "geologico" ? "de deslizamento" : "de enchente"}: ${nome}`));
  }
  corpo.push(bloco("Alertas em vigor", al, 14));
  return montar(cabecalho({ cor: C.accent, icone: "pino", kicker: `${m.regiao} · agora ${quando.split(" ")[1] ?? ""}`,
                            titulo: m.municipio }),
                corpo, rodape("previsão das 8 famílias de modelos do TEMPO-RJ, pluviômetros do CEMADEN e Alerta Rio, descargas da REDEMET, modelo de impacto (ANEEL), INMET e Defesa Civil.", quando, false));
}

// ------------------------------------------------------------------ exemplos dos 9 avisos (marcados TESTE)
const LAGOS = "Região dos Lagos";
export function exemplos(quando: string): { nome: string; aviso: Aviso }[] {
  const base = { quando, teste: true };
  const INMET: [string, string][] = [["Amarelo", C.warning], ["Laranja", C.laranja], ["Vermelho", C.critical]];
  const DC: [string, string][] = [["Muito baixo", C.good], ["Baixo", "#7bbf3a"], ["Moderado", C.warning], ["Alto", C.laranja], ["Muito alto", C.critical]];
  const RISC: [string, string][] = [["Normal", C.muted], ["Moderado", C.warning], ["Elevado", C.laranja], ["Alto", C.critical]];
  return [
    { nome: "Trovoada próxima", aviso: { ...base, cor: C.laranja, icone: "raio", kicker: `Aviso imediato · ${LAGOS}`,
      titulo: "Trovoada próxima", destaque: [
        { nome: "Iguaba Grande", detalhe: "trovoada a ~18 km ao norte", valor: "48%", rotulo: "de chance de chegar" },
        { nome: "São Pedro da Aldeia", detalhe: "trovoada a ~25 km ao norte", valor: "45%", rotulo: "de chance de chegar" },
        { nome: "Cabo Frio", detalhe: "trovoada a ~28 km a noroeste", valor: "41%", rotulo: "de chance de chegar" }],
      secoes: [["Quando", "Pode chegar na próxima hora — ou se desfazer antes. Trovoada de verão costuma nascer e morrer no mesmo lugar."],
               ["O que esperar", "Se chegar: raios, chuva forte por pouco tempo e rajadas de vento. Pode faltar energia."]],
      fazer: "Recolha o que estiver solto, evite áreas abertas e carregue o celular.",
      origem: "descargas atmosféricas detectadas pela Força Aérea (REDEMET) a 10–30 km do município nos últimos 20 min. A chance é aprendida: cada aviso é conferido 2 h depois." } },
    { nome: "Trovoada sobre a cidade", aviso: { ...base, cor: C.critical, icone: "raio", kicker: `Aviso imediato · ${LAGOS}`,
      titulo: "Trovoada sobre a cidade", destaque: [
        { nome: "Silva Jardim", detalhe: "descargas a até 10 km" }, { nome: "Araruama", detalhe: "descargas a até 10 km" },
        { nome: "São Pedro da Aldeia", detalhe: "próxima também: ~22 km a oeste", valor: "48%", rotulo: "de chance de chegar" }],
      corDestaque: C.laranja,
      secoes: [["O que esperar", "Raios, chuva forte e rajadas nos próximos 30 a 60 minutos."]],
      fazer: "Fique em local fechado e tire aparelhos sensíveis da tomada.",
      origem: "descargas atmosféricas detectadas pela Força Aérea (REDEMET) a até 10 km do município nos últimos 20 min." } },
    { nome: "Trovoada se afastou", aviso: { ...base, cor: C.verde, icone: "check", kicker: `Aviso imediato · ${LAGOS}`,
      titulo: "Trovoada se afastou", secoes: [["Situação", "Sem descargas a até 50 km na última hora. O risco imediato passou."]],
      origem: "descargas atmosféricas detectadas pela Força Aérea (REDEMET)." } },
    { nome: "Risco de falta de energia agora", aviso: { ...base, cor: C.laranja, icone: "tomada", kicker: `Aviso imediato · ${LAGOS}`,
      titulo: "Risco de falta de energia agora", destaque: [{ nome: "Silva Jardim, Araruama e São Pedro da Aldeia" }],
      secoes: [["Por quê", "Trovoada sobre a cidade (descargas atmosféricas e rajadas)."],
               ["O que significa", "Raios e rajadas de tempestade costumam provocar desligamentos na rede elétrica."]],
      fazer: "Carregue celulares e lanternas e tire aparelhos sensíveis da tomada.",
      origem: "aviso de trovoada do TEMPO-RJ, com base nas descargas detectadas pela Força Aérea (REDEMET)." } },
    { nome: "Alerta do INMET", aviso: { ...base, cor: C.laranja, icone: "alerta", kicker: `Alerta oficial · ${LAGOS}`,
      titulo: "INMET: Tempestade", escala: { niveis: INMET, atual: 1, titulo: "Nível do alerta" },
      secoes: [["Onde", "Araruama, Armação dos Búzios, Arraial do Cabo, Cabo Frio, Iguaba Grande, São Pedro da Aldeia, Saquarema e Silva Jardim"],
               ["Quando", "Até 23h59 de hoje"],
               ["O que esperar", "Chuva entre 30 e 60 mm/h ou 50 e 100 mm/dia, ventos intensos (60–100 km/h) e queda de granizo."],
               ["Riscos", "Corte de energia, queda de galhos de árvores, alagamentos e descargas elétricas."]],
      origem: "aviso oficial do INMET (Instituto Nacional de Meteorologia), nível Perigo, publicado para estes municípios." } },
    { nome: "Defesa Civil · deslizamento", aviso: { ...base, cor: C.critical, icone: "montanha", kicker: "Defesa Civil · Serrana",
      titulo: "Risco de deslizamento", escala: { niveis: DC, atual: 4, titulo: "Nível de risco geológico" },
      destaque: [{ nome: "Petrópolis" }, { nome: "Teresópolis" }],
      secoes: [["O que significa", "O solo está encharcado e há chance real de deslizamento em encostas."]],
      fazer: "Fique atento a rachaduras, estalos e água barrenta nas encostas. Em caso de risco, ligue para a Defesa Civil: 199.",
      origem: "Defesa Civil do Estado do RJ (painel CEMADEN-RJ), nível de risco geológico publicado oficialmente para o município." } },
    { nome: "Defesa Civil · enchente", aviso: { ...base, cor: C.laranja, icone: "onda", kicker: "Defesa Civil · Serrana",
      titulo: "Risco de enchente", escala: { niveis: DC, atual: 3, titulo: "Nível de risco hidrológico" },
      destaque: [{ nome: "Nova Friburgo" }],
      secoes: [["O que significa", "Rios e córregos podem transbordar e alagar as áreas próximas."]],
      fazer: "Evite margens de rios e ruas que costumam alagar. Em caso de risco, ligue para a Defesa Civil: 199.",
      origem: "Defesa Civil do Estado do RJ (painel CEMADEN-RJ), nível de risco hidrológico publicado oficialmente para o município." } },
    { nome: "Risco alto de falta de energia (previsto)", aviso: { ...base, cor: C.critical, icone: "tomada", kicker: "Previsão · Noroeste",
      titulo: "Risco alto de falta de energia amanhã", escala: { niveis: RISC, atual: 3, titulo: "Risco elétrico previsto" },
      destaque: [{ nome: "Itaperuna, Cambuci e Laje do Muriaé", detalhe: "ocorrências na rede elétrica esperadas", valor: "3,4×", rotulo: "o de um dia normal" }],
      secoes: [["Por quê", "Rajadas de até 70 km/h e chuva forte previstas pelos modelos."]],
      fazer: "Carregue celulares e lanternas e evite deixar a geladeira cheia de perecíveis.",
      origem: "modelo de impacto do TEMPO-RJ: a previsão das 8 famílias de modelos (rajada, chuva por hora e instabilidade) aplicada ao histórico de interrupções de energia da ANEEL em cada município." } },
    { nome: "Chuva forte agora", aviso: { ...base, cor: C.azul, icone: "chuva", kicker: "Medição · Costa do Sol",
      titulo: "Chuva forte agora", destaque: [
        { nome: "Casimiro de Abreu", detalhe: "pluviômetro do CEMADEN", valor: "30 mm", rotulo: "na última hora" },
        { nome: "Rio das Ostras", detalhe: "pluviômetro do CEMADEN", valor: "52 mm", rotulo: "em 24 horas" }],
      secoes: [["O que significa", "Chuva intensa, com risco de alagamento em pontos baixos nas próximas horas."]],
      fazer: "Evite ruas que costumam alagar e não atravesse água corrente.",
      origem: "pluviômetros do CEMADEN e do Alerta Rio no município. Limite do aviso: 30 mm em 1 hora ou 50 mm em 24 horas." } },
  ];
}
