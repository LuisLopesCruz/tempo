# -*- coding: utf-8 -*-
"""D14 — o radar do Pico do Couto mede a chuva onde o CEMADEN nao mede?

Uso:  REDEMET_KEY=<chave> python 12_testar_radar.py
      (precisa de radar_cemaden.parquet: horas chuvosas do CEMADEN exportadas
       do Supabase — hora UTC, ponto_id, mm na hora)

A PERGUNTA
  23 municipios nao tem pluviometro do CEMADEN. O radar (REDEMET, CAPPI 3 km,
  imagem PNG de 250x250 px, ~2 km/px, quadro a cada 20 min) cobre todos. Se a
  cor do radar no ponto do municipio acompanhar a chuva medida, ele preenche o
  buraco. Mas a regua honesta NAO e "o radar acerta?": e "o radar acerta MAIS
  do que simplesmente usar o pluviometro do municipio vizinho?" — porque essa
  alternativa ja existe e custa zero.

COMO SE LE O PNG
  A imagem nao traz numero, so cor: uma rampa continua de ~117 cores (ciano
  claro = eco fraco ... azul ... verde ... amarelo ... laranja ... vermelho
  escuro = eco forte). A documentacao nao publica a escala; aqui a cor vira
  POSICAO na rampa (0 = mais fraca). A conversao para mm/h supoe a rampa linear
  em dBZ de 5 a 70 e Marshall-Palmer — so serve para somar os 3 quadros da hora.
  Por isso as medidas principais sao de ORDEM (Spearman) e de DETECCAO (choveu
  >= 1 mm ou nao), que nao dependem dessa suposicao.
"""
import os, sys, json, math, colorsys, io, time, urllib.request, concurrent.futures as cf
import numpy as np, pandas as pd
from PIL import Image

CHAVE = os.environ.get("REDEMET_KEY") or sys.exit("defina REDEMET_KEY")
API = "https://api-redemet.decea.mil.br/produtos/radar/03km?area=pc&data=%s&anima=%d"
LA0, LA1, LO0, LO1 = -24.701, -20.2013, -45.7583, -40.8262     # bounds do 03km/pc
CEN = (-22.464278, -43.297476)
N = 250

# ------------------------------------------------------------------ pontos
PONTOS = "1:-23.0067:-44.3181;2:-21.6208:-42.1028;3:-22.8728:-42.3431;4:-22.2306:-43.1056;7:-22.4700:-43.8256;8:-22.5442:-44.1714;9:-22.7642:-43.3994;10:-22.1519:-42.4194;11:-21.1339:-41.6797;13:-22.4625:-42.6531;14:-21.5753:-41.9111;15:-22.1872:-41.6611;16:-22.0286:-43.2050;17:-21.7523:-41.3304;18:-21.9811:-42.3681;19:-21.4883:-41.6156;20:-21.9336:-42.6086;21:-22.4806:-42.2042;22:-22.0853:-41.8683;23:-22.0286:-42.3608;24:-22.0511:-42.5217;25:-22.7856:-43.3117;27:-22.5372:-42.9819;29:-22.7444:-42.8594;30:-22.8522:-43.7753;31:-21.4208:-41.6908;33:-21.2050:-41.8878;34:-22.4961:-44.5633;35:-22.6431:-43.6533;36:-21.2064:-42.1225;38:-21.9839:-42.2528;39:-22.6528:-43.0406;40:-22.9597:-44.0406;41:-22.9194:-42.8186;42:-22.5267:-43.7328;43:-22.7825:-43.4286;44:-22.4539:-43.4689;47:-22.8075:-43.4139;48:-22.8833:-43.1036;49:-22.2819:-42.5311;50:-22.7592:-43.4511;52:-22.1585:-43.2932;53:-23.2178:-44.7131;54:-22.4286:-43.4186;55:-22.5050:-43.1786;57:-22.6292:-43.8981;59:-22.4197:-44.2903;61:-22.7161:-43.5553;63:-22.4689:-44.4467;64:-22.7086:-42.6097;65:-22.7231:-44.1356;68:-22.9064:-43.1822;69:-21.9553:-42.0081;71:-21.4775:-41.1078;72:-21.6461:-41.7469;73:-22.8269:-43.0539;74:-21.6403:-41.0511;75:-22.8039:-43.3722;77:-22.1521:-42.9233;79:-21.9572:-42.1347;80:-21.9950:-42.9144;81:-22.8989:-42.4699;82:-22.7439:-43.7075;84:-22.0497:-42.6747;85:-22.7303:-42.7142;86:-22.4167:-42.9782;87:-22.0633:-42.0664;88:-22.1167:-43.2092;89:-22.2456:-43.7003;90:-20.9311:-41.8686;91:-22.4039:-43.6625;92:-22.5231:-44.1042"
pts = pd.DataFrame([dict(ponto_id=int(a), la=float(b), lo=float(c)) for a, b, c in (x.split(":") for x in PONTOS.split(";"))])
KX = 111.32 * math.cos(math.radians(-22.0))
pts["dist_km"] = np.hypot((pts.lo - CEN[1]) * KX, (pts.la - CEN[0]) * 110.57)
pts["px"] = ((pts.lo - LO0) / (LO1 - LO0) * N).astype(int)
pts["py"] = ((LA1 - pts.la) / (LA1 - LA0) * N).astype(int)


# ------------------------------------------------------------ cor -> posicao
def chave_rampa(rgb):
    """Ordena a cor ao longo da rampa: ciano claro -> azul -> azul escuro ->
    verde-agua -> verde vivo -> verde escuro -> amarelo -> laranja -> vermelho."""
    r, g, b = (int(v) for v in rgb)
    if b >= 230 and r <= 120:                     # ciano/azul: G cai
        return (0, -g * 1000 + r * -1)
    if r == 0 and 10 <= b < 230:                  # azul escuro -> verde-agua: G sobe
        return (1, g)
    if r <= 1 and b <= 1 and g >= 140:            # verdes: escurecem
        return (2, -g)
    if r < 240 and g >= 140 and b == 0 and r > 1:  # verde-amarelado: R sobe
        return (3, r)
    if r >= 230 and g >= 1 and b == 0:            # amarelo -> laranja -> vermelho: G cai
        return (4, -g)
    return (5, -r)                                # vermelho escuro: R cai


def baixar(url, tent=4):
    for t in range(tent):
        try:
            req = urllib.request.Request(url, headers={"X-Api-Key": CHAVE} if "api-redemet" in url else {})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception:
            if t == tent - 1:
                raise
            time.sleep(4 * (t + 1))


# ------------------------------------------------------------ dados de chuva
obs = pd.read_parquet("radar_cemaden.parquet").merge(pts, on="ponto_id")
obs["t"] = pd.to_datetime(obs.hora, format="%Y%m%d%H")
horas = sorted(obs.t.unique())
print("CEMADEN: %d ponto-hora em %d horas | >=1 mm: %d" % (len(obs), len(horas), (obs.mm >= 1).sum()))

# quadros de H-3 a H+3 (para testar a defasagem / fuso)
pedir = sorted({pd.Timestamp(h) + pd.Timedelta(hours=k) for h in horas for k in range(-2, 4)})
listas = {}
def lista(h):
    d = json.loads(baixar(API % (h.strftime("%Y%m%d%H"), 3)))["data"]
    return [(f[0]["data"], f[0]["path"]) for f in d["radar"] if f and f[0].get("path")]
with cf.ThreadPoolExecutor(6) as ex:
    for h, l in zip(pedir, ex.map(lista, pedir)):
        for dt_, url in l:
            listas[dt_] = url
print("quadros listados: %d" % len(listas))

img = {}
def ler(item):
    dt_, url = item
    for t in range(3):      # PNG truncado na origem acontece: tenta de novo, depois desiste
        try:
            return dt_, np.array(Image.open(io.BytesIO(baixar(url))).convert("RGBA"))
        except Exception:
            time.sleep(3)
    return dt_, None
perdidos = 0
with cf.ThreadPoolExecutor(8) as ex:
    for dt_, a in ex.map(ler, listas.items()):
        if a is None:
            perdidos += 1
        else:
            img[pd.Timestamp(dt_)] = a
print("quadros baixados: %d | perdidos: %d" % (len(img), perdidos))

cores = set()
for a in img.values():
    op = a[..., 3] > 0
    cores.update(map(tuple, a[op][:, :3]))
rampa = sorted(cores, key=chave_rampa)
pos = {c: i for i, c in enumerate(rampa)}
NR = len(rampa)
print("cores na rampa: %d | fraca %s ... forte %s" % (NR, rampa[0], rampa[-1]))

def taxa(i):          # posicao -> mm/h (rampa linear 5..70 dBZ, Marshall-Palmer)
    dbz = 5 + 65 * i / (NR - 1)
    return (10 ** (dbz / 10) / 200) ** (1 / 1.6)

# posicao media numa janela 5x5 px (~10 km) em torno de cada ponto, por quadro
quadro_pt = {}
for t, a in img.items():
    v = []
    for p in pts.itertuples():
        w = a[max(p.py - 2, 0):p.py + 3, max(p.px - 2, 0):p.px + 3]
        mm = [taxa(pos[tuple(c[:3])]) if c[3] > 0 else 0.0 for c in w.reshape(-1, 4)]
        v.append(float(np.mean(mm)))
    quadro_pt[t] = dict(zip(pts.ponto_id, v))

def radar_hora(fim, pid):
    """chuva estimada na hora que TERMINA em `fim`: media dos quadros dentro dela."""
    qs = [quadro_pt[t][pid] for t in quadro_pt if fim - pd.Timedelta(hours=1) <= t < fim]
    return np.mean(qs) if qs else np.nan

def spearman(a, b):    # .values: sem isso o pandas alinha por indice e mistura linhas
    return pd.Series(np.asarray(a)).rank().corr(pd.Series(np.asarray(b)).rank())

def deteccao(chuva_obs, chuva_est, lim_obs=1.0, lim_est=1.0):
    o = np.asarray(chuva_obs) >= lim_obs; e = np.asarray(chuva_est) >= lim_est
    a = (o & e).sum(); b = (~o & e).sum(); c = (o & ~e).sum()
    return a / max(a + c, 1), b / max(a + b, 1), a / max(a + b + c, 1)

# ----------------------------------------------------- 1) qual e a hora certa?
print("\n=== defasagem: hora do CEMADEN x janela do radar ===")
melhor = []
for lag in (-3, -2, -1, 0, 1, 2):
    est = np.array([radar_hora(t + pd.Timedelta(hours=lag + 1), p) for t, p in zip(obs.t, obs.ponto_id)])
    ok = ~np.isnan(est)
    s = spearman(est[ok], obs.mm[ok]) if ok.sum() > 100 else float("nan")
    melhor.append((s if s == s else -1, lag))
    print("  janela [H%+d, H%+d): Spearman %.3f  (n=%d)" % (lag, lag + 1, s, ok.sum()))

LAG = max(melhor)[1]
print("  -> usando a janela [H%+d, H%+d)" % (LAG, LAG + 1))
obs["radar"] = [radar_hora(t + pd.Timedelta(hours=LAG + 1), p) for t, p in zip(obs.t, obs.ponto_id)]
obs = obs.dropna(subset=["radar"])

# ------------------------------------- 2) a alternativa: o vizinho mais perto
viz = {}
for p in pts.itertuples():
    d = np.hypot((pts.lo - p.lo) * KX, (pts.la - p.la) * 110.57); d[pts.ponto_id == p.ponto_id] = 1e9
    viz[p.ponto_id] = (int(pts.ponto_id.iloc[int(np.argmin(d))]), float(d.min()))
tab = obs.set_index(["hora", "ponto_id"]).mm
obs["vizinho"] = [tab.get((h, viz[p][0]), np.nan) for h, p in zip(obs.hora, obs.ponto_id)]
obs["dist_viz"] = [viz[p][1] for p in obs.ponto_id]

# --------------------------------------------------------- 3) o confronto
lim = obs.groupby(pd.cut(obs.radar, [0, .05, .1, .2, .5, 1, 2, 5, 1e9], right=False)).mm.agg(["count", "mean"])
print("\n=== radar (mm/h estimado) x chuva medida media ===\n", lim.round(2).to_string())

best = max((deteccao(obs.mm, obs.radar, 1, l)[2], l) for l in (0.05, 0.1, 0.2, 0.3, 0.5, 1, 2))
print("\nlimiar do radar que maximiza o CSI: %.2f mm/h" % best[1])

print("\n=== por distancia do radar ===")
print("%-12s %6s | %-24s | %-24s" % ("faixa", "n", "RADAR  spear  POD  FAR  CSI", "VIZINHO spear POD FAR CSI"))
for nome, a, b in (("< 80 km", 0, 80), ("80-150 km", 80, 150), (">= 150 km", 150, 999), ("todos", 0, 999)):
    s = obs[(obs.dist_km >= a) & (obs.dist_km < b)]
    sv = s.dropna(subset=["vizinho"])
    r = deteccao(s.mm, s.radar, 1, best[1]); v = deteccao(sv.mm, sv.vizinho, 1, 1)
    print("%-12s %6d | %.3f %.2f %.2f %.2f | %.3f %.2f %.2f %.2f" % (
        nome, len(s), spearman(s.radar, s.mm), *r, spearman(sv.vizinho, sv.mm), *v))

print("\ndistancia ao vizinho com pluviometro: mediana %.0f km" % obs.drop_duplicates("ponto_id").dist_viz.median())
obs.to_parquet("radar_teste.parquet", index=False)
