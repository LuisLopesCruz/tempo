// ============================================================================
// TEMPO-RJ - serve o painel HTML direto do Supabase.
// ----------------------------------------------------------------------------
// Mesma origem da API: sem CORS, sem hospedagem externa, sem tela de login.
// Publico e somente leitura (verify_jwt = false). O HTML nao carrega segredo:
// leva apenas a publishable key, cujo alcance e limitado pela RLS.
// ============================================================================
const HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TEMPO-RJ</title>
<style>
:root{
  color-scheme: light;
  --plane:#f9f9f7; --surface:#fcfcfb;
  --ink:#0b0b0b; --ink-2:#52514e; --ink-muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --ring:rgba(11,11,11,.10);
  --good:#0ca30c; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
  --accent:#2a78d6;
  --s0:#eeeeea; --s1:#cde2fb; --s2:#b7d3f6; --s3:#9ec5f4;
  --s4:#6da7ec; --s5:#3987e5; --s6:#256abf; --s7:#184f95; --s8:#0d366b;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    color-scheme: dark;
    --plane:#0d0d0d; --surface:#1a1a19;
    --ink:#fff; --ink-2:#c3c2b7; --ink-muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,.10);
    --accent:#3987e5;
    --s0:#232322; --s1:#0d366b; --s2:#104281; --s3:#184f95;
    --s4:#256abf; --s5:#3987e5; --s6:#5598e7; --s7:#86b6ef; --s8:#cde2fb;
  }
}
:root[data-theme="dark"]{
  color-scheme: dark;
  --plane:#0d0d0d; --surface:#1a1a19;
  --ink:#fff; --ink-2:#c3c2b7; --ink-muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,.10);
  --accent:#3987e5;
  --s0:#232322; --s1:#0d366b; --s2:#104281; --s3:#184f95;
  --s4:#256abf; --s5:#3987e5; --s6:#5598e7; --s7:#86b6ef; --s8:#cde2fb;
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:24px 20px 64px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between;margin-bottom:20px}
h1{font-size:19px;font-weight:640;letter-spacing:-.01em;margin:0}
h1 span{color:var(--ink-muted);font-weight:400}
.meta{font-size:12px;color:var(--ink-muted);font-variant-numeric:tabular-nums}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:18px;margin-bottom:16px}
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px}
select,button{font:inherit;color:var(--ink);background:var(--surface);
  border:1px solid var(--axis);border-radius:8px;padding:8px 11px;cursor:pointer}
select{min-width:230px}
button:hover{border-color:var(--accent)}
button.ghost{background:transparent}
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:20px}
.tile .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-muted);margin-bottom:6px}
.tile .val{font-size:32px;font-weight:660;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}
.tile .sub{font-size:12px;color:var(--ink-2);margin-top:4px}
.consenso{display:inline-flex;gap:3px;align-items:center;margin-top:8px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--s0);box-shadow:0 0 0 1px var(--ring) inset}
.dot.on{background:var(--accent);box-shadow:none}
h2{font-size:13px;font-weight:620;margin:0 0 3px;letter-spacing:.01em}
.hint{font-size:12px;color:var(--ink-muted);margin:0 0 14px}
.hm{overflow-x:auto}
.hm table{border-collapse:separate;border-spacing:2px;min-width:660px}
.hm th{font-size:10px;font-weight:500;color:var(--ink-muted);padding:0;text-align:center;font-variant-numeric:tabular-nums}
.hm td.day{font-size:11px;color:var(--ink-2);text-align:right;padding-right:8px;white-space:nowrap;font-variant-numeric:tabular-nums}
.cell{width:22px;height:20px;border-radius:4px;background:var(--s0);cursor:default}
.cell[data-k="1"]{background:var(--s1)}.cell[data-k="2"]{background:var(--s2)}
.cell[data-k="3"]{background:var(--s3)}.cell[data-k="4"]{background:var(--s4)}
.cell[data-k="5"]{background:var(--s5)}.cell[data-k="6"]{background:var(--s6)}
.cell[data-k="7"]{background:var(--s7)}.cell[data-k="8"]{background:var(--s8)}
.cell.vazio{background:transparent;box-shadow:0 0 0 1px var(--grid) inset}
.legenda{display:flex;align-items:center;gap:7px;margin-top:12px;font-size:11px;color:var(--ink-muted);flex-wrap:wrap}
.legenda i{width:16px;height:11px;border-radius:3px;display:inline-block}
.bars{display:grid;gap:10px;margin-top:4px}
.bar-row{display:grid;grid-template-columns:88px 1fr 84px;gap:12px;align-items:center}
.bar-row .d{font-size:12px;color:var(--ink-2);font-variant-numeric:tabular-nums}
.track{position:relative;height:16px;background:var(--s0);border-radius:4px}
.fill{position:absolute;inset:0 auto 0 0;background:var(--accent);border-radius:4px}
.band{position:absolute;top:50%;height:2px;transform:translateY(-50%);
  background:var(--ink-muted);opacity:.55;border-radius:2px}
.bar-row .v{font-size:12px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink-2)}
table.tab{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
table.tab th{text-align:left;font-weight:560;color:var(--ink-muted);font-size:11px;
  text-transform:uppercase;letter-spacing:.05em;padding:7px 10px 7px 0;border-bottom:1px solid var(--grid)}
table.tab td{padding:7px 10px 7px 0;border-bottom:1px solid var(--grid);color:var(--ink-2)}
table.tab td:first-child{color:var(--ink)}
.tag{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:560;
  padding:2px 8px;border-radius:999px;border:1px solid var(--ring)}
.tag.serious::before{content:"▲";color:var(--serious)}
.aviso{font-size:12.5px;color:var(--ink-2);line-height:1.65}
.aviso b{color:var(--ink);font-weight:600}
footer{margin-top:28px;padding-top:18px;border-top:1px solid var(--grid);
  font-size:12px;color:var(--ink-muted);line-height:1.7}
#tip{position:fixed;z-index:50;pointer-events:none;opacity:0;transition:opacity .1s;
  background:var(--surface);border:1px solid var(--ring);border-radius:8px;padding:9px 11px;
  font-size:12px;line-height:1.55;box-shadow:0 6px 22px rgba(0,0,0,.16);max-width:230px}
#tip b{display:block;margin-bottom:3px;color:var(--ink)}
#tip span{color:var(--ink-2)}
.erro{color:var(--critical)}
[hidden]{display:none!important}
@media(max-width:560px){.bar-row{grid-template-columns:70px 1fr 70px}.wrap{padding:16px 14px 48px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>TEMPO&#8209;RJ <span>&middot; previs&atilde;o consolidada</span></h1>
    <div class="meta" id="meta">carregando&hellip;</div>
  </header>

  <div class="controls">
    <select id="mun" aria-label="Munic&iacute;pio"></select>
    <button class="ghost" id="btnTab" type="button" aria-expanded="false">Ver tabela</button>
  </div>

  <div class="card">
    <div class="hero" id="hero"></div>
  </div>

  <div class="card">
    <h2>Probabilidade de chuva, hora a hora</h2>
    <p class="hint">Cada c&eacute;lula &eacute; uma hora. A cor mostra quantas das 8 fam&iacute;lias de modelo,
      independentes entre si, preveem chuva. Passe o mouse para os detalhes.</p>
    <div class="hm" id="hm"></div>
    <div class="legenda">
      <span>0 de 8</span>
      <i style="background:var(--s0)"></i><i style="background:var(--s1)"></i>
      <i style="background:var(--s2)"></i><i style="background:var(--s3)"></i>
      <i style="background:var(--s4)"></i><i style="background:var(--s5)"></i>
      <i style="background:var(--s6)"></i><i style="background:var(--s7)"></i>
      <i style="background:var(--s8)"></i>
      <span>8 de 8 concordam</span>
    </div>
  </div>

  <div class="card">
    <h2>Chuva acumulada por dia</h2>
    <p class="hint">Barra = mediana das linhagens. A linha cinza atr&aacute;s &eacute; a faixa entre o
      percentil 25 e o 75 &mdash; quanto mais larga, menos os modelos concordam.</p>
    <div class="bars" id="bars"></div>
  </div>

  <div class="card" id="cardTab" hidden>
    <h2>Tabela</h2>
    <p class="hint">Mesmos dados em texto, para leitura assistiva e confer&ecirc;ncia.</p>
    <div style="overflow-x:auto"><table class="tab" id="tab"></table></div>
  </div>

  <div class="card">
    <h2>Como ler isto</h2>
    <p class="aviso">
      A probabilidade aqui <b>n&atilde;o</b> vem de um app de previs&atilde;o. Ela &eacute; a fra&ccedil;&atilde;o de
      <b>fam&iacute;lias de modelo independentes</b> que concordam &mdash; ECMWF, NOAA, DWD, ECCC,
      M&eacute;t&eacute;o&#8209;France, JMA, UKMO e CMA. Doze aplicativos que rodam o mesmo GFS por baixo
      contariam como <b>uma</b> opini&atilde;o, n&atilde;o doze.<br><br>
      Quando os modelos discordam, o sistema mostra a discord&acirc;ncia em vez de escond&ecirc;-la
      atr&aacute;s de uma m&eacute;dia. <b>Dispers&atilde;o alta = n&uacute;mero central pouco confi&aacute;vel.</b><br><br>
      Os pesos por acerto hist&oacute;rico ainda <b>n&atilde;o</b> est&atilde;o aplicados: sem previs&otilde;es
      verificadas contra observa&ccedil;&atilde;o, n&atilde;o h&aacute; evid&ecirc;ncia para preferir um modelo a outro.
      At&eacute; l&aacute;, todas as fam&iacute;lias valem igual.
    </p>
  </div>

  <footer>
    Modelos via Open&#8209;Meteo &middot; coleta a cada 6 h (ciclos 00/06/12/18 UTC) &middot; 92 munic&iacute;pios do RJ.<br>
    Uso pessoal. N&atilde;o substitui alertas oficiais da Defesa Civil, do INMET ou do CEMADEN.<br>
    Interrup&ccedil;&otilde;es de energia em tempo real (consulta manual, painel da ANEEL):
    <a href="https://portalrelatorios.aneel.gov.br/hubDistribuicao/monitoramentoInterrupcoesFornecimentoBrasil" target="_blank" rel="noopener"
       style="color:var(--accent)">Monitoramento de Interrup&ccedil;&otilde;es</a>.
  </footer>
</div>
<div id="tip" role="tooltip"></div>

<script>
const API = "https://hmwevcpcelmwnonbeojy.supabase.co/rest/v1";
const KEY = "sb_publishable_6Fsy4PJ2_smg55pujx4RhQ__6Zn9DHD";
const H = { apikey: KEY, Authorization: "Bearer " + KEY };
const FAMILIAS = 8;

const $ = (s) => document.querySelector(s);
const ls = {
  get(k){ try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch (e) {} }
};
const nf = (n, d) => Number(n).toLocaleString("pt-BR", {
  minimumFractionDigits: d === undefined ? 1 : d,
  maximumFractionDigits: d === undefined ? 1 : d
});
const diaSem = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
const dd = (n) => String(n).padStart(2, "0");

async function api(path){
  const r = await fetch(API + path, { headers: H });
  if (!r.ok) throw new Error("HTTP " + r.status + " - " + (await r.text()).slice(0, 120));
  return r.json();
}

let MUNS = [];


// ---------------------------------------------------------------- tooltip
const tip = $("#tip");
function mostrarTip(e, titulo, corpo){
  tip.innerHTML = "<b>" + titulo + "</b><span>" + corpo + "</span>";
  tip.style.opacity = "1";
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width  > window.innerWidth  - 8) x = e.clientX - r.width  - 14;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = x + "px";
  tip.style.top  = y + "px";
}
function esconderTip(){ tip.style.opacity = "0"; }

// ----------------------------------------------------------------- render
function renderHero(linhas){
  const j6  = linhas.filter((d) => d.horizonte_h >= 0 && d.horizonte_h <= 6);
  const j24 = linhas.filter((d) => d.horizonte_h >= 0 && d.horizonte_h <= 24);
  if (!j6.length){
    $("#hero").innerHTML = "<div class='tile'><div class='sub erro'>Sem dados para as proximas horas.</div></div>";
    return;
  }
  const maxP     = Math.max.apply(null, j6.map((d) => +d.prob_chuva));
  const maxForte = Math.max.apply(null, j24.map((d) => +d.prob_chuva_forte));
  const chuva24  = j24.reduce((s, d) => s + (+d.precip_mediana), 0);
  const raj      = Math.max.apply(null, j24.map((d) => +d.rajada_max));
  const k        = Math.round(maxP * FAMILIAS);

  const dots = Array.from({ length: FAMILIAS }, (_, i) =>
    '<i class="dot' + (i < k ? " on" : "") + '"></i>').join("");

  $("#hero").innerHTML =
    '<div class="tile"><div class="lbl">Chuva nas proximas 6 h</div>' +
      '<div class="val">' + Math.round(maxP * 100) + '%</div>' +
      '<div class="consenso">' + dots + '</div>' +
      '<div class="sub">' + k + ' de ' + FAMILIAS + ' familias concordam</div></div>' +
    '<div class="tile"><div class="lbl">Chuva forte em 24 h</div>' +
      '<div class="val">' + Math.round(maxForte * 100) + '%</div>' +
      '<div class="sub">acima de 15 mm em uma hora</div></div>' +
    '<div class="tile"><div class="lbl">Acumulado 24 h</div>' +
      '<div class="val">' + nf(chuva24) + '<span style="font-size:16px;color:var(--ink-muted)"> mm</span></div>' +
      '<div class="sub">mediana das linhagens</div></div>' +
    '<div class="tile"><div class="lbl">Rajada maxima 24 h</div>' +
      '<div class="val">' + Math.round(raj) + '<span style="font-size:16px;color:var(--ink-muted)"> km/h</span></div>' +
      '<div class="sub">' + (raj >= 60
        ? '<span class="tag serious">risco de queda de rede</span>'
        : "dentro do normal") + '</div></div>';
}

function renderHeatmap(linhas){
  const porDia = new Map();
  for (const d of linhas){
    const t = new Date(d.valido_em);
    const chave = t.getFullYear() + "-" + dd(t.getMonth() + 1) + "-" + dd(t.getDate());
    if (!porDia.has(chave)) porDia.set(chave, new Array(24).fill(null));
    porDia.get(chave)[t.getHours()] = d;
  }
  let html = "<table><thead><tr><th></th>";
  for (let h = 0; h < 24; h++) html += "<th>" + (h % 3 === 0 ? dd(h) : "") + "</th>";
  html += "</tr></thead><tbody>";
  for (const par of Array.from(porDia.entries()).slice(0, 6)){
    const dt = new Date(par[0] + "T12:00:00");
    html += '<tr><td class="day">' + diaSem[dt.getDay()] + " " + dd(dt.getDate()) + "/" + dd(dt.getMonth() + 1) + "</td>";
    for (const d of par[1]){
      if (!d){ html += '<td><div class="cell vazio"></div></td>'; continue; }
      const k = Math.round(+d.prob_chuva * FAMILIAS);
      html += '<td><div class="cell" data-k="' + k + '" data-i="' + d.valido_em + '"></div></td>';
    }
    html += "</tr>";
  }
  $("#hm").innerHTML = html + "</tbody></table>";

  const idx = new Map(linhas.map((d) => [d.valido_em, d]));
  const hm = $("#hm");
  hm.onmousemove = function (e){
    const c = e.target.closest ? e.target.closest(".cell[data-i]") : null;
    if (!c){ esconderTip(); return; }
    const d = idx.get(c.getAttribute("data-i"));
    if (!d) return;
    const t = new Date(d.valido_em);
    const k = Math.round(+d.prob_chuva * FAMILIAS);
    mostrarTip(e,
      dd(t.getHours()) + ":00 &middot; " + diaSem[t.getDay()] + " " + t.getDate(),
      k + " de " + FAMILIAS + " familias preveem chuva<br>" +
      "mediana " + nf(d.precip_mediana) + " mm &middot; max " + nf(d.precip_max) + " mm<br>" +
      "dispersao " + nf(d.dispersao_precip) + " mm &middot; rajada " + Math.round(d.rajada_max) + " km/h");
  };
  hm.onmouseleave = esconderTip;
}

function renderBarras(linhas){
  const porDia = new Map();
  for (const d of linhas){
    const t = new Date(d.valido_em);
    const chave = t.getFullYear() + "-" + dd(t.getMonth() + 1) + "-" + dd(t.getDate());
    const a = porDia.get(chave) || { med: 0, p25: 0, p75: 0 };
    a.med += +d.precip_mediana; a.p25 += +d.precip_p25; a.p75 += +d.precip_p75;
    porDia.set(chave, a);
  }
  const dias = Array.from(porDia.entries()).slice(0, 6);
  const teto = Math.max.apply(null, [6].concat(dias.map((p) => p[1].p75)));
  $("#bars").innerHTML = dias.map(function (par){
    const dt = new Date(par[0] + "T12:00:00");
    const a = par[1];
    const pc = (v) => Math.min(100, (v / teto) * 100);
    return '<div class="bar-row">' +
      '<div class="d">' + diaSem[dt.getDay()] + " " + dd(dt.getDate()) + "/" + dd(dt.getMonth() + 1) + '</div>' +
      '<div class="track">' +
        '<div class="band" style="left:' + pc(a.p25) + '%;width:' + Math.max(1, pc(a.p75) - pc(a.p25)) + '%"></div>' +
        '<div class="fill" style="width:' + pc(a.med) + '%"></div>' +
      '</div>' +
      '<div class="v">' + nf(a.med) + ' mm</div></div>';
  }).join("");
}

function renderTabela(linhas){
  const rows = linhas.filter((d) =>
    d.horizonte_h >= 0 && d.horizonte_h <= 48 && new Date(d.valido_em).getHours() % 3 === 0);
  $("#tab").innerHTML =
    "<thead><tr><th>Quando</th><th>Prob. chuva</th><th>Familias</th><th>Mediana</th>" +
    "<th>Faixa p25-p75</th><th>Max</th><th>Rajada</th></tr></thead><tbody>" +
    rows.map(function (d){
      const t = new Date(d.valido_em);
      const k = Math.round(+d.prob_chuva * FAMILIAS);
      return "<tr><td>" + diaSem[t.getDay()] + " " + dd(t.getDate()) + "/" + dd(t.getMonth() + 1) +
        " " + dd(t.getHours()) + "h</td>" +
        "<td>" + Math.round(d.prob_chuva * 100) + "%</td>" +
        "<td>" + k + " de " + FAMILIAS + "</td>" +
        "<td>" + nf(d.precip_mediana) + " mm</td>" +
        "<td>" + nf(d.precip_p25) + "-" + nf(d.precip_p75) + " mm</td>" +
        "<td>" + nf(d.precip_max) + " mm</td>" +
        "<td>" + Math.round(d.rajada_max) + " km/h</td></tr>";
    }).join("") + "</tbody>";
}

async function carregar(pontoId){
  ls.set("tempo_mun", pontoId);
  $("#meta").textContent = "carregando...";
  try {
    const linhas = await api("/tempo_previsao?ponto_id=eq." + pontoId +
      "&select=valido_em,horizonte_h,n_familias,precip_mediana,precip_p25,precip_p75," +
      "precip_max,dispersao_precip,rajada_max,prob_chuva,prob_chuva_forte&order=valido_em.asc");
    if (!linhas.length){
      $("#meta").innerHTML = '<span class="erro">Sem previsao para este municipio.</span>';
      return;
    }
    renderHero(linhas); renderHeatmap(linhas); renderBarras(linhas); renderTabela(linhas);
    $("#meta").textContent = linhas[0].n_familias + " familias de modelo · " +
      linhas.length + " horas previstas";
  } catch (e) {
    $("#meta").innerHTML = '<span class="erro">Falha ao carregar: ' + e.message + "</span>";
  }
}

async function init(){
  try {
    MUNS = await api("/tempo_municipios?select=ponto_id,municipio,municipio_ibge,regiao&order=municipio.asc");
  } catch (e) {
    $("#meta").innerHTML = '<span class="erro">Falha ao carregar municipios: ' + e.message + "</span>";
    return;
  }
  $("#mun").innerHTML = MUNS.map((m) =>
    '<option value="' + m.ponto_id + '">' + m.municipio + "</option>").join("");

  const salvo = ls.get("tempo_mun");
  const rio = MUNS.filter((m) => m.municipio === "Rio de Janeiro")[0];
  const inicial = (salvo && MUNS.some((m) => String(m.ponto_id) === salvo))
    ? salvo : String(rio ? rio.ponto_id : MUNS[0].ponto_id);

  $("#mun").value = inicial;
  $("#mun").addEventListener("change", (e) => carregar(e.target.value));
  await carregar(inicial);
}

$("#btnTab").addEventListener("click", function (){
  const c = $("#cardTab");
  c.hidden = !c.hidden;
  $("#btnTab").setAttribute("aria-expanded", String(!c.hidden));
  $("#btnTab").textContent = c.hidden ? "Ver tabela" : "Ocultar tabela";
});


init();
</script>
</body>
</html>
`;

Deno.serve(() => new Response(HTML, {
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  },
}));
