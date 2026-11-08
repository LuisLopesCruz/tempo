# -*- coding: utf-8 -*-
"""D15 — aviso de curtissimo prazo: "trovoada se aproximando do municipio".

Uso:  REDEMET_KEY=<chave> python 13_testar_aviso_trovoada.py

POR QUE ISTO E DIFERENTE DO D13
  O D13 perguntou se a trovoada OBSERVADA melhora a conta de ocorrencias do
  DIA: nao melhora. Aqui a pergunta e outra: com a tempestade ja no ar, da para
  avisar o municipio que ela vai chegar ANTES dela chegar? Em 07/11/2026 a
  linha levou ~2 h da Metropolitana aos Lagos e nenhum modelo a previu.

A REGRA (por municipio, a cada quadro do STSC — 6 a 9 min)
  d(t) = distancia da celula com trovoada mais proxima ao ponto do municipio.
  CHEGOU      d <= 10 km.
  A CAMINHO   10 < d <= 50 km E a celula mais proxima ha ~30 min estava pelo
              menos 5 km mais longe E essa aproximacao implica <= VMAX km/h.
  O teto de velocidade existe porque celula NOVA nascendo perto parece
  "aproximacao" de 280 km/h (visto em 07/11 nos Lagos); tempestade de verdade
  anda a 20-80 km/h.

COMO SE MEDE
  Chegada = d <= 10 km depois de >= 60 min sem isso. Acerto = houve A CAMINHO
  nas 3 h antes da chegada; antecedencia = chegada - primeiro aviso. Alarme
  falso = A CAMINHO sem chegada nas 3 h seguintes (avisos repetidos dentro
  dessa janela contam uma vez).
"""
import os, sys, json, math, time, urllib.request, concurrent.futures as cf
import numpy as np, pandas as pd

CHAVE = os.environ.get("REDEMET_KEY") or sys.exit("defina REDEMET_KEY")
URL = "https://api-redemet.decea.mil.br/produtos/stsc?data=%s&anima=12"
LAT, LON = (-23.6, -20.5), (-45.3, -40.6)
AQUI = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(AQUI, "raio_stsc_cheio.parquet")
KX = 111.32 * math.cos(math.radians(-22.0))

ib = [int(x) for x in open(os.path.join(AQUI, "ibges.txt")).read().split(",")]
la = [float(x) for x in open(os.path.join(AQUI, "lats.txt")).read().split(",")]
lo = [float(x) for x in open(os.path.join(AQUI, "lons.txt")).read().split(",")]

# ------------------------------------------------ dias: os mais tempestuosos
# (pelo historico horario do passo 1) + 07/11, o caso que motivou o teste
h = pd.read_parquet(os.path.join(AQUI, "raio_stsc_horas.parquet"))
h["dia"] = (pd.to_datetime(h.hora, format="%Y%m%d%H") - pd.Timedelta(hours=3)).dt.date
DIAS = sorted(h.groupby("dia").pontos_rj.sum().nlargest(14).index) + [pd.Timestamp("2026-11-07").date()]


def buscar(hk):
    for t in range(4):
        try:
            req = urllib.request.Request(URL % hk, headers={"X-Api-Key": CHAVE})
            with urllib.request.urlopen(req, timeout=90) as r:
                d = json.load(r)["data"]
            out = []
            for rot, q in zip(d.get("anima") or [], d.get("stsc") or []):
                for p in q:
                    a, b = float(p["la"]), float(p["lo"])
                    if LAT[0] <= a <= LAT[1] and LON[0] <= b <= LON[1]:
                        out.append((hk, rot, a, b))
            return out
        except Exception:
            time.sleep(5 * (t + 1))
    return None


feito = pd.read_parquet(CACHE) if os.path.exists(CACHE) else pd.DataFrame(columns=["hk", "quadro", "la", "lo"])
pedir = []
for dia in DIAS:
    ini = pd.Timestamp(dia) + pd.Timedelta(hours=3)          # 00h local
    for k in range(24):
        hk = (ini + pd.Timedelta(hours=k + 1)).strftime("%Y%m%d%H")   # cada pedido traz ~72 min para tras
        if hk not in set(feito.hk):
            pedir.append(hk)
print("dias: %d | horas a baixar: %d" % (len(DIAS), len(pedir)))
novos, falhas = [], 0
with cf.ThreadPoolExecutor(6) as ex:
    for r in ex.map(buscar, pedir):
        if r is None:
            falhas += 1
        else:
            novos += r
if novos:
    feito = pd.concat([feito, pd.DataFrame(novos, columns=["hk", "quadro", "la", "lo"])])
    feito.to_parquet(CACHE, index=False)
print("falhas: %d" % falhas)

c = feito.copy()
c["la"] = c.la.astype(float); c["lo"] = c.lo.astype(float)   # o concat com o vazio deixa 'object'
# o rotulo do quadro e HH:MM (UTC) do dia do pedido; pedido de 00h UTC traz quadros de 23h do dia anterior
base = pd.to_datetime(c.hk, format="%Y%m%d%H")
t = pd.to_datetime(base.dt.strftime("%Y-%m-%d ") + c.quadro)
t[t > base + pd.Timedelta(minutes=5)] -= pd.Timedelta(days=1)
c["t"] = t
c = c.drop_duplicates(["t", "la", "lo"])
quadros = np.array(sorted(c.t.unique()))
G = {k: (g.la.values, g.lo.values) for k, g in c.groupby("t")}
print("quadros: %d | intervalo mediano %.1f min" % (len(quadros), np.median(np.diff(quadros)) / np.timedelta64(1, "m")))

# distancia minima municipio x quadro
D = np.full((len(ib), len(quadros)), 999.0)
for j, q in enumerate(quadros):
    a, b = G[q]
    for i in range(len(ib)):
        D[i, j] = np.hypot((b - lo[i]) * KX, (a - la[i]) * 110.57).min()


def avaliar(VMAX, RAIO=50, APROX=5):
    acertos, chegadas, falsos, avisos, antec = 0, 0, 0, 0, []
    for i in range(len(ib)):
        d = D[i]
        chegou = d <= 10
        aviso = np.zeros(len(quadros), bool)
        for j, q in enumerate(quadros):
            if not (10 < d[j] <= RAIO):
                continue
            jan = (quadros >= q - np.timedelta64(36, "m")) & (quadros <= q - np.timedelta64(24, "m"))
            if not jan.any():
                continue
            dif = d[jan].min() - d[j]
            dt_h = (q - quadros[jan][np.argmin(d[jan])]) / np.timedelta64(1, "h")
            if dif >= APROX and dif / dt_h <= VMAX:
                aviso[j] = True
        # chegadas (apos >= 60 min sem celula a <= 10 km)
        ultimo = None
        for j in np.where(chegou)[0]:
            q = quadros[j]
            if ultimo is None or q - ultimo >= np.timedelta64(60, "m"):
                chegadas += 1
                av = aviso & (quadros >= q - np.timedelta64(3, "h")) & (quadros < q)
                if av.any():
                    acertos += 1
                    antec.append((q - quadros[av][0]) / np.timedelta64(1, "m"))
            ultimo = q
        # avisos (agrupados em janelas de 3 h) e quais nao tiveram chegada
        k = 0
        idx = np.where(aviso)[0]
        while k < len(idx):
            q0 = quadros[idx[k]]
            avisos += 1
            fut = chegou & (quadros > q0) & (quadros <= q0 + np.timedelta64(3, "h"))
            if not fut.any():
                falsos += 1
            while k < len(idx) and quadros[idx[k]] < q0 + np.timedelta64(3, "h"):
                k += 1
    return chegadas, acertos, avisos, falsos, antec


print("\n%-22s %8s %6s %8s %8s %6s %s" % ("regra", "chegadas", "POD", "avisos", "falsos", "FAR", "antecedencia (min) p25/med/p75"))
for VMAX in (1e9, 120, 90, 60):
    for RAIO in (50, 70):
        ch, ac, av, fa, an = avaliar(VMAX, RAIO)
        print("%-22s %8d %6.2f %8d %8d %6.2f %s" % (
            "vmax %s, raio %d km" % ("livre" if VMAX > 1e6 else "%d" % VMAX, RAIO), ch, ac / max(ch, 1), av, fa,
            fa / max(av, 1), "%.0f / %.0f / %.0f" % tuple(np.percentile(an, [25, 50, 75])) if an else "-"))
print("\ndias usados:", ", ".join(str(d) for d in DIAS))
