# -*- coding: utf-8 -*-
"""D17 — o "trovoada a caminho" acerta POR MUNICIPIO?

Motivo (13/11): em Sao Pedro da Aldeia o bot avisou "a caminho, chega 14h57" e
a trovoada nunca passou de 32 km. Ao vivo, de 07 a 13/11, so 26 de 164 avisos
"a caminho" (16%) tiveram celula a ate 10 km do municipio nas 2 h seguintes.
O D15 media o acerto POR REGIAO; a mensagem, porem, lista municipios com
horario de chegada — e isso que a pessoa le.

O defeito suspeito: a regra compara a celula MAIS PROXIMA agora com a mais
proxima ha 30 min. Em tarde de verao as celulas nascem e morrem paradas na
serra; uma celula NOVA mais perto parece "aproximacao" sem nada ter andado.

Variantes:
  RAIO     distancia maxima para avisar (50 km hoje)
  PERSIST  a aproximacao vale em K quadros seguidos (~6 min cada)
  VIVA     a celula mais proxima ja existia no quadro anterior (ha uma celula a
           ate VIVA km dela ~6-12 min antes) — tira a celula recem-nascida
  MINCEL   celulas a ate 50 km (tempestade organizada)

Acerto = celula a ate 10 km do municipio nas 2 h seguintes ao aviso.
Uso:  python 16_aviso_trovoada_municipio.py   (le raio_stsc_cheio.parquet)
"""
import os, math, numpy as np, pandas as pd

AQUI = os.path.dirname(os.path.abspath(__file__))
KX = 111.32 * math.cos(math.radians(-22.0)); KY = 110.57
la = np.array([float(x) for x in open(os.path.join(AQUI, "lats.txt")).read().split(",")])
lo = np.array([float(x) for x in open(os.path.join(AQUI, "lons.txt")).read().split(",")])

c = pd.read_parquet(os.path.join(AQUI, "raio_stsc_cheio.parquet"))
c["la"] = c.la.astype(float); c["lo"] = c.lo.astype(float)
base = pd.to_datetime(c.hk, format="%Y%m%d%H")
t = pd.to_datetime(base.dt.strftime("%Y-%m-%d ") + c.quadro)
t[t > base + pd.Timedelta(minutes=5)] -= pd.Timedelta(days=1)
c["t"] = t
c = c.drop_duplicates(["t", "la", "lo"])
Q = np.array(sorted(c.t.unique())); NQ, NM = len(Q), len(la)
Qm = Q.astype("datetime64[m]").astype(np.int64)
G = {k: (g.la.values, g.lo.values) for k, g in c.groupby("t")}

D = np.full((NM, NQ), 999.0); N50 = np.zeros((NM, NQ), int)
PLa = np.full((NM, NQ), np.nan); PLo = np.full((NM, NQ), np.nan)   # posicao da celula mais proxima
for j, q in enumerate(Q):
    a, b = G[q]
    d = np.hypot((b[None, :] - lo[:, None]) * KX, (a[None, :] - la[:, None]) * KY)
    k = d.argmin(1)
    D[:, j] = d[np.arange(NM), k]; N50[:, j] = (d <= 50).sum(1)
    PLa[:, j] = a[k]; PLo[:, j] = b[k]

def quadro_ha(minutos, tol):
    out = np.full(NQ, -1)
    for j in range(NQ):
        k = np.where((Qm[j] - Qm >= minutos - tol) & (Qm[j] - Qm <= minutos + tol))[0]
        if len(k):
            out[j] = k[np.argmin(np.abs(Qm[j] - Qm[k] - minutos))]
    return out
ant30 = quadro_ha(30, 6)
ant9 = quadro_ha(9, 4)          # o quadro anterior (~6-13 min)
prev = np.r_[-1, np.arange(NQ - 1)]
contiguo = np.r_[False, (Qm[1:] - Qm[:-1]) <= 15]

# VIVA: a celula mais proxima agora tinha vizinha a <= v km no quadro anterior
def viva(v):
    V = np.zeros((NM, NQ), bool)
    for j in range(NQ):
        k = ant9[j]
        if k < 0:
            continue
        a, b = G[Q[k]]
        d = np.hypot((b[None, :] - PLo[:, j][:, None]) * KX, (a[None, :] - PLa[:, j][:, None]) * KY)
        V[:, j] = d.min(1) <= v
    return V
V8 = viva(8)

ok = ant30 >= 0
dt_h = np.where(ok, (Qm - Qm[np.maximum(ant30, 0)]) / 60.0, np.nan)
dif = np.where(ok, D[:, np.maximum(ant30, 0)] - D, -1)

def avisos(RAIO=50, APROX=5, VMAX=90, PERSIST=1, VIVA=False, MINCEL=1):
    A = (D > 10) & (D <= RAIO) & (dif >= APROX) & (dif / dt_h <= VMAX) & ok[None, :] & (N50 >= MINCEL)
    if VIVA:
        A &= V8
    if PERSIST > 1:
        B = A.copy()
        cont = contiguo.copy()                      # quadros j-k..j sem buraco
        for k in range(1, PERSIST):
            sh = np.zeros_like(A); sh[:, k:] = A[:, :-k]
            if k > 1:
                cont &= np.r_[np.zeros(k - 1, bool), contiguo[:-(k - 1)]]
            B &= sh & cont[None, :]
        A = B
    return A

CHEGA = D <= 10
dias = len({(pd.Timestamp(x) - pd.Timedelta(hours=3)).date() for x in Q})

def medir(A):
    av = ac = 0; antec = []
    for i in range(NM):
        ultimo = None
        for j in np.where(A[i])[0]:
            if ultimo is None or Qm[j] - Qm[ultimo] >= 180:
                av += 1
                w = CHEGA[i] & (Qm > Qm[j]) & (Qm <= Qm[j] + 120)
                if w.any():
                    ac += 1; antec.append(Qm[np.argmax(w)] - Qm[j])
            ultimo = j
    ch = cob = 0
    for i in range(NM):
        ultimo = None
        for j in np.where(CHEGA[i])[0]:
            if ultimo is None or Qm[j] - Qm[ultimo] >= 60:
                ch += 1
                if (A[i] & (Qm >= Qm[j] - 120) & (Qm < Qm[j])).any():
                    cob += 1
            ultimo = j
    return av, ac / max(av, 1), cob / max(ch, 1), (np.median(antec) if antec else np.nan), av / dias

print("quadros %d, %d dias, %d municipios" % (NQ, dias, NM))
print("%-34s %7s %9s %9s %8s %12s" % ("regra", "avisos", "ACERTO", "COBRE", "antec", "aviso/mun/dia"))
for nome, kw in [("NO AR: 50 km", {}),
                 ("raio 30 km", dict(RAIO=30)),
                 ("raio 25 km", dict(RAIO=25)),
                 ("celula viva", dict(VIVA=True)),
                 ("2 quadros seguidos", dict(PERSIST=2)),
                 ("3 quadros seguidos", dict(PERSIST=3)),
                 ("viva + 2 quadros", dict(VIVA=True, PERSIST=2)),
                 ("30 km + viva", dict(RAIO=30, VIVA=True)),
                 ("30 km + viva + 2 quadros", dict(RAIO=30, VIVA=True, PERSIST=2)),
                 ("30 km + 2 quadros", dict(RAIO=30, PERSIST=2)),
                 ("30 km + aprox 10 km", dict(RAIO=30, APROX=10)),
                 ("30 km + >=5 celulas", dict(RAIO=30, MINCEL=5)),
                 ("30 km + viva + >=5 cel + 2q", dict(RAIO=30, VIVA=True, MINCEL=5, PERSIST=2))]:
    av, acerto, cobre, antec, pd_ = medir(avisos(**kw))
    print("%-34s %7d %8.0f%% %8.0f%% %5.0f min %12.3f" % (nome, av, 100 * acerto, 100 * cobre, antec, pd_ / NM))

# referencia: chance de ter celula a <=10 km nas 2 h seguintes SO por haver celula a <=50 / <=30 km
for R in (50, 30, 20):
    P = (D > 10) & (D <= R)
    av, acerto, cobre, antec, _ = medir(P)
    print("%-34s %7d %8.0f%% %8.0f%% %5.0f min" % ("so 'tem celula a <=%d km'" % R, av, 100 * acerto, 100 * cobre, antec))
