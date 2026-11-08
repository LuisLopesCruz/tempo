// ============================================================================
// TEMPO-RJ — coletor de TROVOADA (REDEMET / produto STSC), a cada 6 min
// ----------------------------------------------------------------------------
// Origem: a tempestade de 07/11/2026, que nenhum dos 8 modelos previu (rajada
// prevista de 13-57 km/h) e que levou ~2 h da Metropolitana aos Lagos. Os
// modelos nao veem; o STSC ve a tempestade JA NO AR. Isto e aviso de
// curtissimo prazo, nao previsao — e por isso nao entra em nenhuma conta de
// probabilidade nem de impacto (o D13 mediu: no total do dia nao acrescenta).
//
// A REGRA foi testada no D15 (calibracao/13 e 14), sobre 14 dias de tempestade
// + 07/11. Por regiao: 3 de cada 4 avisos certos, antecedencia mediana 1h47.
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
const RAIO_KM = 50;
const APROX_KM = 5;        // tem de estar pelo menos isto mais perto que ha ~30 min
const VMAX_KMH = 90;       // acima disto e celula NOVA nascendo perto, nao movimento
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
      const dist = quadros.map((q) => {
        let m = Infinity;
        for (let i = 0; i < q.la.length; i++) {
          const dx = (q.lo[i] - pt.lon) * KX, dy = (q.la[i] - pt.lat) * KY;
          const v = dx * dx + dy * dy;
          if (v < m) m = v;
        }
        return Math.sqrt(m);   // Infinity se o quadro nao tem celula no RJ
      });
      const n50 = (() => {
        const q = quadros[quadros.length - 1];
        let c = 0;
        for (let i = 0; i < q.la.length; i++) {
          const dx = (q.lo[i] - pt.lon) * KX, dy = (q.la[i] - pt.lat) * KY;
          if (dx * dx + dy * dy <= RAIO_KM * RAIO_KM) c++;
        }
        return c;
      })();

      let noMun = false;
      let perto = 0;                                   // 0 = nenhum quadro perto
      let a: { t: number; d: number; v: number } | undefined;
      for (let j = 0; j < quadros.length; j++) {
        const q = quadros[j];
        const idade = (ultimo - q.t) / 60_000;
        if (dist[j] <= RAIO_KM && idade <= PERTO_MIN) perto = Math.max(perto, q.t);
        if (idade > JANELA_MIN) continue;
        if (dist[j] <= NO_MUNICIPIO_KM) noMun = true;
        const k = anterior[j];
        if (k < 0 || !(dist[j] > NO_MUNICIPIO_KM && dist[j] <= RAIO_KM)) continue;
        const dif = dist[k] - dist[j];
        const v = dif / ((q.t - quadros[k].t) / 3_600_000);
        // dist[k] = Infinity (nao havia celula ha 30 min) da dif infinita: e celula
        // nova, nao aproximacao — o teto de velocidade a descarta.
        if (dif >= APROX_KM && v <= VMAX_KMH) a = { t: q.t, d: dist[j], v };
      }

      const situacao = noMun ? "no_municipio" : a ? "a_caminho" : perto ? "perto" : "nenhuma";
      const dAgora = dist[dist.length - 1];
      return {
        municipio_ibge: pt.ibge,
        quadro: new Date(ultimo).toISOString(),
        situacao,
        dist_km: Number.isFinite(dAgora) ? Math.round(dAgora * 10) / 10 : null,
        velocidade_kmh: situacao === "a_caminho" && a ? Math.round(a.v) : null,
        chegada_em: situacao === "a_caminho" && a && a.v >= 5
          ? new Date(a.t + ((a.d - NO_MUNICIPIO_KM) / a.v) * 3_600_000).toISOString() : null,
        celulas_50km: n50,
        ultima_perto: perto ? new Date(perto).toISOString() : null,
      };
    });

    const { data, error } = await sb.rpc("tempo_ingerir_trovoada", { p_rows: linhas });
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
