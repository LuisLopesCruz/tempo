# -*- coding: utf-8 -*-
"""D16 — "trovoada a caminho" COM ventania medida antecipa mais falta de luz?

Uso:  REDEMET_KEY=<chave> python 15_testar_ventania.py
      (precisa de raio_stsc_cheio.parquet do 13 e de oc2026.parquet)

A IDEIA (do usuario, depois de 07/11)
  Em 07/11 os aeroportos mediram a rajada andando com a tempestade: Santa Cruz
  74 km/h as 15h00, Galeao 80 as 15h42, Santos Dumont 76 as 16h00, Macae 57 as
  18h20. A rajada nao e um objeto que anda sozinho: e a frente de vento DA
  TEMPESTADE. Entao quem da rumo e velocidade e o rastreio das trovoadas (D15);
  o METAR diz QUANTA ventania aquela tempestade carrega.

O TESTE
  Episodio = primeiro "a caminho" de um municipio (regra do D15) apos 3 h sem.
  Ventania a montante = algum aeroporto a ate 100 km do municipio mediu rajada
  >= LIM nos 120 min antes do aviso, COM celula de trovoada a ate 25 km do
  aeroporto (+-20 min) — rajada de frente fria sem tempestade nao conta.
  Desfecho = ocorrencias da ANEEL que COMECARAM no municipio nas 3 h seguintes
  ao aviso, divididas pela media do proprio municipio em 3 h (jan-jul): 1,0 = o
  normal, 5,0 = cinco vezes o normal.
  Pergunta: o grupo COM ventania tem desfecho claramente maior que o SEM?
  E o controle: nos MESMOS dias (dia com ventania em algum lugar), a diferenca
  continua? Se sumir, era so "dia ruim", nao o aviso.
"""
import os, sys, re, json, math, time, urllib.request
import numpy as np, pandas as pd, pyarrow.parquet as pq

CHAVE = os.environ.get("REDEMET_KEY") or sys.exit("defina REDEMET_KEY")
AQUI = os.path.dirname(os.path.abspath(__file__))
KX = 111.32 * math.cos(math.radians(-22.0))
km = lambda la1, lo1, la2, lo2: np.hypot((lo1 - lo2) * KX, (la1 - la2) * 110.57)

AERO = {"SBAF": (-22.875, -43.3844), "SBCB": (-22.9217, -42.0742), "SBCP": (-21.6983, -41.3017),
        "SBES": (-22.8128, -42.0925), "SBFS": (-22.0289, -41.0697), "SBGL": (-22.8089, -43.2436),
        "SBJR": (-22.9867, -43.3719), "SBME": (-22.3425, -41.7656), "SBMI": (-22.9181, -42.8289),
        "SBPW": (-21.8047, -41.1097), "SBRJ": (-22.9103, -43.1631), "SBSC": (-22.9322, -43.7189),
        "SDAG": (-22.9753, -44.3072), "SBZM": (-21.5131, -43.1731), "SBBQ": (-21.2669, -43.7608)}

# ------------------------------------------------------------- trovoada (D15)
c = pd.read_parquet(os.path.join(AQUI, "raio_stsc_cheio.parquet"))
c["la"] = c.la.astype(float); c["lo"] = c.lo.astype(float)
base = pd.to_datetime(c.hk, format="%Y%m%d%H")
t = pd.to_datetime(base.dt.strftime("%Y-%m-%d ") + c.quadro)
t[t > base + pd.Timedelta(minutes=5)] -= pd.Timedelta(days=1)
c["t"] = t
c = c.drop_duplicates(["t", "la", "lo"])
c = c[c.t < "2026-08-01"]                         # so o periodo com ANEEL (07/11 fica fora)
Q = np.array(sorted(c.t.unique()))
Qm = Q.astype("datetime64[m]").astype(np.int64)
G = {k: (g.la.values, g.lo.values) for k, g in c.groupby("t")}

ib = np.array([int(x) for x in open(os.path.join(AQUI, "ibges.txt")).read().split(",")])
la = np.array([float(x) for x in open(os.path.join(AQUI, "lats.txt")).read().split(",")])
lo = np.array([float(x) for x in open(os.path.join(AQUI, "lons.txt")).read().split(",")])
NM, NQ = len(ib), len(Q)
D = np.full((NM, NQ), 999.0)
for j, q in enumerate(Q):
    a, b = G[q]
    D[:, j] = np.hypot((b[None, :] - lo[:, None]) * KX, (a[None, :] - la[:, None]) * 110.57).min(1)
ant = np.full(NQ, -1)
for j in range(NQ):
    k = np.where((Qm[j] - Qm >= 24) & (Qm[j] - Qm <= 36))[0]
    if len(k):
        ant[j] = k[np.argmin(np.abs(Qm[j] - Qm[k] - 30))]
ok = ant >= 0
dif = np.where(ok, D[:, np.maximum(ant, 0)] - D, -1)
dt_h = np.where(ok, (Qm - Qm[np.maximum(ant, 0)]) / 60.0, np.nan)
AV = (D > 10) & (D <= 50) & (dif >= 5) & (dif / dt_h <= 90) & ok[None, :]

episodios = []                                    # (municipio, t0 UTC)
for i in range(NM):
    ultimo = None
    for j in np.where(AV[i])[0]:
        if ultimo is None or Qm[j] - Qm[ultimo] >= 180:
            episodios.append((i, pd.Timestamp(Q[j])))
        ultimo = j
ep = pd.DataFrame(episodios, columns=["i", "t0"])
dias = sorted({(x - pd.Timedelta(hours=3)).date() for x in ep.t0} | {(pd.Timestamp(x) - pd.Timedelta(hours=3)).date() for x in Q})
print("episodios 'a caminho': %d em %d dias" % (len(ep), len(dias)))

# ------------------------------------------------------------------ METAR
CACHE = os.path.join(AQUI, "metar_rj.parquet")
if os.path.exists(CACHE):
    met = pd.read_parquet(CACHE)
else:
    rows = []
    for dia in dias:
        ini = (pd.Timestamp(dia) + pd.Timedelta(hours=1)).strftime("%Y%m%d%H")
        fim = (pd.Timestamp(dia) + pd.Timedelta(hours=28)).strftime("%Y%m%d%H")
        url = "https://api-redemet.decea.mil.br/mensagens/metar/%s?data_ini=%s&data_fim=%s&page_tam=1000" % (",".join(AERO), ini, fim)
        for tent in range(4):
            try:
                req = urllib.request.Request(url, headers={"X-Api-Key": CHAVE})
                d = json.load(urllib.request.urlopen(req, timeout=90))
                pag = d.get("data", {})
                for m in pag.get("data", []):
                    rows.append((m["id_localidade"] if "id_localidade" in m else m["mens"].split()[1 if not m["mens"].startswith(("METAR COR", "SPECI COR")) else 2],
                                 m["validade_inicial"], m["mens"]))
                break
            except Exception as e:
                time.sleep(5 * (tent + 1))
    met = pd.DataFrame(rows, columns=["est", "t", "mens"]).drop_duplicates()
    met.to_parquet(CACHE, index=False)

def rajada_kt(msg):
    m = re.search(r" (?:\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT", msg)
    if not m:
        return np.nan
    return float(m.group(2) or m.group(1))        # a rajada; sem rajada, o vento medio
met["t"] = pd.to_datetime(met.t)
met["kt"] = met.mens.map(rajada_kt)
met = met.dropna(subset=["kt"])
met = met[met.est.isin(list(AERO))]
print("METAR/SPECI lidos: %d de %d aeroportos | rajada >= 30 kt: %d" % (len(met), met.est.nunique(), (met.kt >= 30).sum()))

# rajada COM tempestade: celula a <= 25 km do aeroporto, +-20 min
def com_tempestade(r):
    a = AERO[r.est]
    jj = np.where(np.abs(Qm - np.datetime64(r.t, "m").astype(np.int64)) <= 20)[0]
    for j in jj:
        x, y = G[Q[j]]
        if (np.hypot((y - a[1]) * KX, (x - a[0]) * 110.57) <= 25).any():
            return True
    return False
met["tempestade"] = met.apply(com_tempestade, axis=1)

# ------------------------------------------------------------------ ANEEL
tb = pq.read_table(os.path.join(AQUI, "oc2026.parquet"), columns=["CodMunicipioIBGE", "DthIniOcorrencia"],
                   filters=[("CodMunicipioIBGE", ">=", "3300000"), ("CodMunicipioIBGE", "<=", "3399999")])
o = tb.to_pandas()
o["ib"] = pd.to_numeric(o.CodMunicipioIBGE, errors="coerce")
o["t"] = pd.to_datetime(o.DthIniOcorrencia, errors="coerce")          # hora LOCAL
o = o.dropna(subset=["ib", "t"]); o["ib"] = o.ib.astype(int)
print("ANEEL: %d ocorrencias | com hora diferente de 00:00: %.0f%%" % (len(o), 100 * (o.t.dt.hour + o.t.dt.minute > 0).mean()))
horas = (o.t.max() - o.t.min()).total_seconds() / 3600
base3h = o.groupby("ib").size() / (horas / 3)
porm = {k: np.sort(g.t.values) for k, g in o.groupby("ib")}

def desfecho(i, t0):
    m = ib[i]
    if m not in porm or base3h.get(m, 0) <= 0:
        return np.nan
    a = np.datetime64(t0 - pd.Timedelta(hours=3)); b = a + np.timedelta64(3, "h")   # UTC -> local
    v = porm[m]
    return (np.searchsorted(v, b) - np.searchsorted(v, a)) / base3h[m]

ep["desfecho"] = [desfecho(i, t0) for i, t0 in zip(ep.i, ep.t0)]
ep["dia"] = [(x - pd.Timedelta(hours=3)).date() for x in ep.t0]
ep = ep.dropna(subset=["desfecho"])

def resumo(nome, s):
    if not len(s):
        return "%-44s n=0" % nome
    ep_ = s.std(ddof=1) / math.sqrt(len(s)) if len(s) > 1 else float("nan")
    return "%-44s n=%4d  media %5.2f (+-%.2f)  mediana %5.2f  >=3x o normal: %3.0f%%" % (
        nome, len(s), s.mean(), 1.96 * ep_, s.median(), 100 * (s >= 3).mean())

for LIM in (25, 30, 35):
    fortes = met[(met.kt >= LIM) & met.tempestade]
    tem = []
    for i, t0 in zip(ep.i, ep.t0):
        f = fortes[(fortes.t >= t0 - pd.Timedelta(minutes=120)) & (fortes.t <= t0)]
        dd = [km(la[i], lo[i], *AERO[e]) for e in f.est]
        tem.append(any(d <= 100 for d in dd))
    ep["vent"] = tem
    dias_vent = set(ep.dia[ep.vent])
    print("\n=== rajada >= %d kt (%d km/h) com tempestade: %d medicoes em %d dias ===" % (
        LIM, round(LIM * 1.852), len(fortes), fortes.t.dt.date.nunique()))
    print(resumo("a caminho SEM ventania a montante", ep.desfecho[~ep.vent]))
    print(resumo("a caminho COM ventania a montante", ep.desfecho[ep.vent]))
    mesmo = ep[ep.dia.isin(dias_vent)]
    print("  controle — so dias em que houve ventania associada:")
    print(resumo("    SEM", mesmo.desfecho[~mesmo.vent]))
    print(resumo("    COM", mesmo.desfecho[mesmo.vent]))
