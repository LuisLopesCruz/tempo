# -*- coding: utf-8 -*-
"""D15, parte 2 — a regra do 13 acerta 2/3 das chegadas com ~2 h de antecedencia,
mas MAIS DA METADE dos avisos e alarme falso (trovoada que se desfaz ou muda de
rumo). Para virar mensagem no celular isso e ruido demais. Aqui se testam dois
filtros e, principalmente, a medida que importa para o envio: POR REGIAO, porque
a mensagem sai uma por regiao, nao uma por municipio.

  MINCEL   tempestade ORGANIZADA: pelo menos N celulas a ate 50 km (uma celula
           solta e trovoada de verao local; a linha de 07/11 tinha dezenas).
  PERSIST  a aproximacao tem de valer em K quadros seguidos (~6 min cada), nao
           num so — tira o salto de uma celula que nasce perto.

Uso:  python 14_refinar_aviso_trovoada.py   (le raio_stsc_cheio.parquet do 13)
"""
import os, math, numpy as np, pandas as pd

AQUI = os.path.dirname(os.path.abspath(__file__))
KX = 111.32 * math.cos(math.radians(-22.0))
la = np.array([float(x) for x in open(os.path.join(AQUI, "lats.txt")).read().split(",")])
lo = np.array([float(x) for x in open(os.path.join(AQUI, "lons.txt")).read().split(",")])
reg = np.array(open(os.path.join(AQUI, "regioes.txt"), encoding="utf-8").read().split(","))

c = pd.read_parquet(os.path.join(AQUI, "raio_stsc_cheio.parquet"))
c["la"] = c.la.astype(float); c["lo"] = c.lo.astype(float)
base = pd.to_datetime(c.hk, format="%Y%m%d%H")
t = pd.to_datetime(base.dt.strftime("%Y-%m-%d ") + c.quadro)
t[t > base + pd.Timedelta(minutes=5)] -= pd.Timedelta(days=1)
c["t"] = t
c = c.drop_duplicates(["t", "la", "lo"])
Q = np.array(sorted(c.t.unique()))
NQ, NM = len(Q), len(la)

D = np.full((NM, NQ), 999.0)      # distancia da celula mais proxima
N50 = np.zeros((NM, NQ), int)     # celulas a ate 50 km
for j, (q, g) in enumerate(c.groupby("t")):
    d = np.hypot((g.lo.values[None, :] - lo[:, None]) * KX, (g.la.values[None, :] - la[:, None]) * 110.57)
    D[:, j] = d.min(1); N50[:, j] = (d <= 50).sum(1)

# para cada quadro: o quadro "de ~30 min atras" (o mais proximo de 30 min, entre 24 e 36)
Qm = Q.astype("datetime64[m]").astype(np.int64)
ant = np.full(NQ, -1)
for j in range(NQ):
    k = np.where((Qm[j] - Qm >= 24) & (Qm[j] - Qm <= 36))[0]
    if len(k):
        ant[j] = k[np.argmin(np.abs(Qm[j] - Qm[k] - 30))]
dt_h = np.where(ant >= 0, (Qm - Qm[np.maximum(ant, 0)]) / 60.0, np.nan)


def avisos(VMAX=90, RAIO=50, APROX=5, MINCEL=1, PERSIST=1):
    A = np.zeros((NM, NQ), bool)
    ok = ant >= 0
    dif = np.where(ok, D[:, np.maximum(ant, 0)] - D, -1)
    A[:, ok] = ((D > 10) & (D <= RAIO) & (dif >= APROX) & (dif / dt_h <= VMAX) & (N50 >= MINCEL))[:, ok]
    if PERSIST > 1:
        B = A.copy()
        for k in range(1, PERSIST):
            B[:, k:] &= A[:, :-k]; B[:, :k] = False
        A = B
    return A


def episodios(serie_bool, janela_min, quieto_min=None):
    """inicios de episodio: True apos (quieto_min) sem True; se quieto_min None, agrupa em janelas."""
    idx = np.where(serie_bool)[0]; out = []; ultimo = None
    for j in idx:
        if ultimo is None or Qm[j] - Qm[ultimo] >= (quieto_min or janela_min):
            out.append(j)
            if quieto_min is None:
                ultimo = j; continue
        if quieto_min is not None:
            ultimo = j
    return out


def medir(A, C):
    """A: avisos (linhas x quadros), C: chegadas. Devolve POD, FAR, antecedencia mediana, avisos."""
    ch = ac = av = fa = 0; antec = []
    for i in range(A.shape[0]):
        for j in episodios(C[i], 0, quieto_min=60):
            ch += 1
            w = A[i] & (Qm >= Qm[j] - 180) & (Qm < Qm[j])
            if w.any():
                ac += 1; antec.append(Qm[j] - Qm[np.argmax(w)])
        for j in episodios(A[i], 180):
            av += 1
            if not (C[i] & (Qm > Qm[j]) & (Qm <= Qm[j] + 180)).any():
                fa += 1
    return ch, ac / max(ch, 1), av, fa / max(av, 1), (np.median(antec) if antec else np.nan)


CHEGA = D <= 10
REGS = sorted(set(reg))
CHEGA_R = np.array([CHEGA[reg == r].any(0) for r in REGS])
dias = len({(pd.Timestamp(x) - pd.Timedelta(hours=3)).date() for x in Q} & set(
    (pd.to_datetime(c.hk, format="%Y%m%d%H") - pd.Timedelta(hours=4)).dt.date))   # dias LOCAIS pedidos
print("quadros: %d em %d dias | municipios: %d | regioes: %d" % (NQ, dias, NM, len(REGS)))
print("\n%-28s | %-34s | %-40s" % ("", "POR MUNICIPIO", "POR REGIAO (o que vira mensagem)"))
print("%-28s | %5s %5s %6s %8s | %5s %5s %6s %8s %10s" % ("regra", "POD", "FAR", "avisos", "antec", "POD", "FAR", "avisos", "antec", "msgs/dia"))
for nome, kw in [("base (vmax 90, 50 km)", {}),
                 ("+ >=5 celulas", dict(MINCEL=5)),
                 ("+ >=15 celulas", dict(MINCEL=15)),
                 ("+ 2 quadros seguidos", dict(PERSIST=2)),
                 ("+ >=15 cel + 2 quadros", dict(MINCEL=15, PERSIST=2)),
                 ("+ >=30 cel + 2 quadros", dict(MINCEL=30, PERSIST=2))]:
    A = avisos(**kw)
    m = medir(A, CHEGA)
    AR = np.array([A[reg == r].any(0) for r in REGS])
    r = medir(AR, CHEGA_R)
    print("%-28s | %5.2f %5.2f %6d %5.0f min | %5.2f %5.2f %6d %5.0f min %10.1f" % (nome, m[1], m[3], m[2], m[4], r[1], r[3], r[2], r[4], r[2] / dias))
