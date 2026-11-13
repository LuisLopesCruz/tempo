// ============================================================================
// TEMPO-RJ — coletor de TROVOADA (REDEMET / produto STSC), a cada 6 min
// ----------------------------------------------------------------------------
// Origem: a tempestade de 07/11/2026, que nenhum dos 8 modelos previu (rajada
// prevista de 13-57 km/h) e que levou ~2 h da Metropolitana aos Lagos. Os
// modelos nao veem; o STSC ve a tempestade JA NO AR. Isto e aviso de
// curtissimo prazo, nao previsao — e por isso nao entra em nenhuma conta de
// probabilidade nem de impacto (o D13 mediu: no total do dia nao acrescenta).
//
// A REGRA (D17, 13/11/2026): "a_caminho" = celula a 10-30 km nos ultimos 20
// min. A regra antiga (D15) exigia que a celula mais proxima estivesse 5 km mais
// perto que ha 30 min, mas em tarde de verao isso media celula NOVA nascendo
// mais perto, nao movimento: acertava 38% por municipio, contra 50% do criterio
// de 30 km. O horario de chegada saiu: era precisao falsa.
// A chance de cada aviso NAO e calculada aqui: o banco a aprende, conferindo
// cada aviso 2 h depois (sql/101). Aqui so se mandam as caracteristicas do
// momento (distancia, celulas a ate 50 km, aproximacao) e os quadros brutos.
//
// SEM ESTADO: cada execucao le os ultimos ~70 min de quadros (anima=12) e
// recalcula tudo. Nao depende de a execucao anterior ter dado certo.
//
// verify_jwt FICA EM false: quem chama e o pg_cron via pg_net, com o
// cabecalho x-tempo-secret. Ligar verify_jwt derruba a coleta com 401 (v7 do
// coletor de observacao, 03/10/2026).
// A chave da REDEMET chega no cabecalho x-redemet-key, montado pelo banco a
// partir de tempo.config. Nunca no codigo, nunca no git.
// ============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const SEGREDO = Deno.env.get("TEMPO_SEGREDO");
const STSC = "https://api-redemet.decea.mil.br/produtos/stsc?anima=12&data=";
const LAT: [number, number] = [-23.6, -20.5];   // RJ com folga de ~30 km
const LON: [number, number] = [-45.3, -40.6];
const KX = 111.32 * Math.cos(-22 * Math.PI / 180);   // km por grau de longitude
const KY = 110.57;

const NO_MUNICIPIO_KM = 10;
const RAIO_KM = 50;         // "perto" (e o "se afastou" do bot)
const ALERTA_KM = 30;       // "a_caminho": trovoada que pode chegar
const JANELA_MIN = 20;     // histerese de no_municipio / a_caminho
const PERTO_MIN = 60;      // histerese de perto (e o "se afastou" do bot)

type Ponto = { ibge: number; lat: number; lon: number };
type Quadro = { t: number; la: number[]; lo: number[] };

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

// O STSC rotula cada quadro so com "HH:MM" (UTC). O dia vem do pedido: tudo
// que passar do fim da hora pedida e do dia anterior (pedido das 00h UTC traz
// quadros das 23h da vespera).
function instante(rot: string, horaPedida: Date): number {
  const [h, m] = rot.split(":").map(Number);
  const t = new Date(horaPedida);
  t.setUTCHours(h, m, 0, 0);
  if (t.getTime() > horaPedida.getTime() + 65 * 60_000) t.setUTCDate(t.getUTCDate() - 1);
  return t.getTime();
}

Deno.serve(async (req: Request) => {
  if (!SEGREDO) return json({ erro: "TEMPO_SEGREDO nao configurado" }, 500);
  if (req.headers.get("x-tempo-secret") !== SEGREDO) return json({ erro: "nao autorizado" }, 401);
  const chave = req.headers.get("x-redemet-key");

  const t0 = Date.now();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const problemas: string[] = [];
  let n = 0, nQuadros = 0;

  try {
    if (!chave) throw new Error("x-redemet-key ausente (tempo.config redemet_chave)");

    const { data: alvos, error: eAlvos } = await sb.rpc("tempo_trovoada_alvos");
    if (eAlvos) throw new Error("alvos: " + eAlvos.message);
    const pontos = alvos as Ponto[];
    if (!pontos?.length) throw new Error("sem municipios");

    const hora = new Date(); hora.setUTCMinutes(0, 0, 0);
    const rotulo = hora.toISOString().slice(0, 13).replace(/[-T]/g, "");   // YYYYMMDDHH
    const r = await fetch(STSC + rotulo, { headers: { "X-Api-Key": chave }, signal: AbortSignal.timeout(40_000) });
    if (!r.ok) throw new Error(`REDEMET HTTP ${r.status}`);
    const d = (await r.json())?.data ?? {};
    const rotulos: string[] = d.anima ?? [];
    const listas: any[][] = d.stsc ?? [];
    if (!rotulos.length) throw new Error("STSC sem quadros");

    const quadros: Quadro[] = rotulos.map((rot, i) => {
      const la: number[] = [], lo: number[] = [];
      for (const p of listas[i] ?? []) {
        const a = +p.la, b = +p.lo;
        if (a >= LAT[0] && a <= LAT[1] && b >= LON[0] && b <= LON[1]) { la.push(a); lo.push(b); }
      }
      return { t: instante(rot, hora), la, lo };
    }).sort((x, y) => x.t - y.t);
    nQuadros = quadros.length;
    const ultimo = quadros[quadros.length - 1].t;

    // quadro "de ~30 min atras" para cada quadro: o mais perto de 30 min, entre 24 e 36
    const anterior = quadros.map((q) => {
      let melhor = -1, erro = 1e9;
      quadros.forEach((p, k) => {
        const dm = (q.t - p.t) / 60_000;
        if (dm >= 24 && dm <= 36 && Math.abs(dm - 30) < erro) { melhor = k; erro = Math.abs(dm - 30); }
      });
      return melhor;
    });

    const linhas = pontos.map((pt) => {
      const maisPerto: number[] = [];   // indice da celula mais proxima em cada quadro
      const dist = quadros.map((q) => {
        let m = Infinity, im = -1;
        for (let i = 0; i < q.la.length; i++) {
          const dx = (q.lo[i] - pt.lon) * KX, dy = (q.la[i] - pt.lat) * KY;
          const v = dx * dx + dy * dy;
          if (v < m) { m = v; im = i; }
        }
        maisPerto.push(im);
        return Math.sqrt(m);   // Infinity se o quadro nao tem celula no RJ
      });
      // De onde a trovoada vem: o lado do municipio em que esta a celula mais
      // proxima no quadro do aviso. 8 rumos, em palavras ("vindo de oeste").
      const rumo = (j: number) => {
        const i = maisPerto[j];
        if (i < 0) return null;
        const q = quadros[j];
        const ang = (Math.atan2((q.lo[i] - pt.lon) * KX, (q.la[i] - pt.lat) * KY) * 180 / Math.PI + 360) % 360;
        return ["norte", "nordeste", "leste", "sudeste", "sul", "sudoeste", "oeste", "noroeste"][Math.round(ang / 45) % 8];
      };
      const celulas50 = (j: number) => {
        const q = quadros[j];
        let c = 0;
        for (let i = 0; i < q.la.length; i++) {
          const dx = (q.lo[i] - pt.lon) * KX, dy = (q.la[i] - pt.lat) * KY;
          if (dx * dx + dy * dy <= RAIO_KM * RAIO_KM) c++;
        }
        return c;
      };

      let noMun = false;
      let perto = 0;                                   // 0 = nenhum quadro perto
      let a = -1;                                      // quadro mais recente com celula a 10-30 km
      for (let j = 0; j < quadros.length; j++) {
        const idade = (ultimo - quadros[j].t) / 60_000;
        if (dist[j] <= RAIO_KM && idade <= PERTO_MIN) perto = Math.max(perto, quadros[j].t);
        if (idade > JANELA_MIN) continue;
        if (dist[j] <= NO_MUNICIPIO_KM) noMun = true;
        else if (dist[j] <= ALERTA_KM) a = j;
      }

      const situacao = noMun ? "no_municipio" : a >= 0 ? "a_caminho" : perto ? "perto" : "nenhuma";
      const dAgora = dist[dist.length - 1];
      const k = a >= 0 ? anterior[a] : -1;
      const aprox = k >= 0 && Number.isFinite(dist[k]) ? dist[k] - dist[a] : null;
      return {
        municipio_ibge: pt.ibge,
        quadro: new Date(ultimo).toISOString(),
        situacao,
        dist_km: Number.isFinite(dAgora) ? Math.round(dAgora * 10) / 10 : null,
        dist_alerta_km: a >= 0 ? Math.round(dist[a] * 10) / 10 : null,
        velocidade_kmh: null,
        chegada_em: null,
        celulas_50km: celulas50(a >= 0 ? a : quadros.length - 1),
        aprox_km: aprox != null ? Math.round(aprox * 10) / 10 : null,
        ultima_perto: perto ? new Date(perto).toISOString() : null,
        vem_de: situacao === "a_caminho" ? rumo(a) : null,
      };
    });

    // os quadros vao para o banco: base para testar regras futuras com dado real
    const pQuadros = quadros.map((q) => ({ t: new Date(q.t).toISOString(),
      la: q.la.map((v) => Math.round(v * 100) / 100), lo: q.lo.map((v) => Math.round(v * 100) / 100) }));

    const { data, error } = await sb.rpc("tempo_ingerir_trovoada", { p_rows: linhas, p_quadros: pQuadros });
    if (error) throw new Error("ingestao: " + error.message);
    n = (data as number) ?? 0;
  } catch (e) {
    problemas.push(e instanceof Error ? e.message : String(e));
  }

  const ms = Date.now() - t0;
  try {
    await sb.rpc("tempo_log_coleta", {
      p_fonte: "trovoada", p_ms: ms, p_ok: problemas.length === 0, p_n: n,
      p_erro: problemas.length ? problemas.join(" | ").slice(0, 2000) : null,
    });
  } catch (_) { /* o log nunca derruba a coleta */ }

  return json({ ok: problemas.length === 0, municipios: n, quadros: nQuadros, ms, problemas },
              problemas.length ? 500 : 200);
});
