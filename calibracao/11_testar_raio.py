# -*- coding: utf-8 -*-
"""D13 — PASSO 2: trovoada OBSERVADA explica as ocorrencias melhor que a chuva?

Uso:  python 11_testar_raio.py      (precisa de raio_stsc*.parquet do passo 1)

A HIPOTESE
  A causa "raio" da camada 3 e medida por um SUBSTITUTO: a chuva horaria maxima
  do dia (`chuva_h_max`), porque nao havia dado de descarga atmosferica. O STSC
  da REDEMET da a trovoada observada, celula de ~5,5 km, desde ~2022. Se o
  substituto for fraco, trocar pelo dado real deve baixar o erro.

O DRIVER
  "horas com trovoada perto": em quantas das 24 horas do dia local houve ao
  menos uma celula STSC a ate R km do ponto do municipio. Ponto e raio fixo —
  e assim que os drivers do ERA5 ja sao tomados (valor no ponto do municipio).
  R testado em 10, 15 e 25 km.

O QUE CONTA COMO VITORIA (mesma regua do D11/CAPE e do D12/solo)
  ganho de MAE claro, coeficiente monotonico, e o que acontece com os outros
  drivers quando o raio entra (se ele so rouba sinal da chuva, nao acrescenta).
  Ajuste sobre 2026 jan-jul: o unico ano da ANEEL que ficou em disco.
"""
import json, glob, math, pandas as pd, numpy as np, pyarrow.parquet as pq

ANO = 2026

# ---------------------------------------------------- pontos dos municipios
ib = [int(x) for x in open('ibges.txt').read().strip().split(',')]
la = [float(x) for x in open('lats.txt').read().strip().split(',')]
lo = [float(x) for x in open('lons.txt').read().strip().split(',')]
pts = pd.DataFrame({'CodIBGE': ib, 'la': la, 'lo': lo})

# ---------------------------------------------------- trovoada por municipio-dia
ctl = pd.read_parquet('raio_stsc_horas.parquet')
ctl['hora_utc'] = pd.to_datetime(ctl.hora, format='%Y%m%d%H')
ctl['dia'] = (ctl.hora_utc - pd.Timedelta(hours=3)).dt.date
cobertura = ctl[ctl.ok].groupby('dia').size()
dias_ok = set(cobertura[cobertura >= 22].index)      # dia com >= 22 das 24 horas
print('horas pedidas: %d | ok: %d | dias completos: %d de %d'
      % (len(ctl), int(ctl.ok.sum()), len(dias_ok), ctl.dia.nunique()))

cel = pd.read_parquet('raio_stsc.parquet')
cel['dia'] = (pd.to_datetime(cel.hora_utc) - pd.Timedelta(hours=3)).dt.date
print('celulas com trovoada na regiao do RJ: %d' % len(cel))


def horas_perto(R):
    out = []
    kx = 111.32 * math.cos(math.radians(-22.0))     # km por grau de longitude
    for p in pts.itertuples():
        dx = (cel.lo.values - p.lo) * kx
        dy = (cel.la.values - p.la) * 110.57
        perto = cel[(dx * dx + dy * dy) <= R * R]
        h = perto.groupby('dia').hora_utc.nunique()
        out.append(pd.DataFrame({'CodIBGE': p.CodIBGE, 'dia': h.index, 'raio_h_%d' % R: h.values}))
    return pd.concat(out)


raio = None
for R in (10, 15, 25):
    r = horas_perto(R)
    raio = r if raio is None else raio.merge(r, on=['CodIBGE', 'dia'], how='outer')

# ---------------------------------------------------- ERA5 + CAPE + ANEEL (como 9_testar_solo)
linhas, horas = [], []
for f in sorted(glob.glob('era_%d_*.json' % ANO), key=lambda x: int(x.rsplit('_', 1)[1].split('.')[0])):
    k = int(f.rsplit('_', 1)[1].split('.')[0])
    ibk = [int(x) for x in open('era_%d_%d.ibge' % (ANO, k)).read().strip().split(',')]
    js = json.load(open(f, encoding='utf-8'))
    for i, loc in enumerate(js if isinstance(js, list) else [js]):
        dd = loc['daily']
        for jx, dia in enumerate(dd['time']):
            linhas.append((ibk[i], dia, dd['precipitation_sum'][jx], dd['wind_gusts_10m_max'][jx]))
        h = loc['hourly']
        s = pd.DataFrame({'t': pd.to_datetime(h['time']), 'p': h['precipitation']})
        for dia, v in s.groupby(s.t.dt.date).p.max().items():
            horas.append((ibk[i], str(dia), v))
drv = pd.DataFrame(linhas, columns=['CodIBGE', 'dia', 'chuva_dia', 'rajada'])
inten = pd.DataFrame(horas, columns=['CodIBGE', 'dia', 'chuva_h_max'])
for x in (drv, inten):
    x['dia'] = pd.to_datetime(x.dia).dt.date

linhas = []
for f in sorted(glob.glob('cape_%d_*.json' % ANO)):
    k = f.rsplit('_', 1)[1].split('.')[0]
    ibk = [int(x) for x in open('cape_%d_%s.ibge' % (ANO, k)).read().strip().split(',')]
    js = json.load(open(f, encoding='utf-8'))
    for i, loc in enumerate(js if isinstance(js, list) else [js]):
        h = loc['hourly']
        s = pd.DataFrame({'t': pd.to_datetime(h['time']), 'c': h['cape']})
        for dia, v in s.groupby(s.t.dt.date).c.max().items():
            linhas.append((ibk[i], dia, v))
cp = pd.DataFrame(linhas, columns=['CodIBGE', 'dia', 'cape_max'])
cp['dia'] = pd.to_datetime(cp.dia).dt.date

t = pq.read_table('oc%d.parquet' % ANO, columns=['CodMunicipioIBGE', 'DthIniOcorrencia'],
                  filters=[('CodMunicipioIBGE', '>=', '3300000'), ('CodMunicipioIBGE', '<=', '3399999')])
d = t.to_pandas()
d['CodIBGE'] = pd.to_numeric(d.CodMunicipioIBGE, errors='coerce')
d = d.dropna(subset=['CodIBGE']); d['CodIBGE'] = d.CodIBGE.astype(int)
d['dia'] = pd.to_datetime(d.DthIniOcorrencia, errors='coerce').dt.date
d = d.dropna(subset=['dia'])
alvo = d.groupby(['CodIBGE', 'dia']).size().reset_index(name='chamados')

j = (drv.merge(inten, on=['CodIBGE', 'dia'], how='left')
        .merge(cp, on=['CodIBGE', 'dia'], how='left')
        .merge(alvo, on=['CodIBGE', 'dia'], how='left')
        .merge(raio, on=['CodIBGE', 'dia'], how='left'))
j['chamados'] = j.chamados.fillna(0)
for R in (10, 15, 25):
    j['raio_h_%d' % R] = j['raio_h_%d' % R].fillna(0)     # dia completo sem celula = 0 horas
j = j[j.dia.isin(dias_ok)]                                # so dia com o STSC completo
j = j[j.dia <= alvo.dia.max()]
j['dow'] = pd.to_datetime(j.dia).dt.dayofweek
j = j.dropna(subset=['cape_max', 'chuva_h_max'])
print('painel: %d municipio-dia | %s -> %s' % (len(j), j.dia.min(), j.dia.max()))

BW = [0, 30, 40, 50, 60, 70, 1e9];    RW = ['<30', '30-40', '40-50', '50-60', '60-70', '>=70']
BH = [0, 1, 3, 6, 12, 1e9];           RH = ['<1', '1-3', '3-6', '6-12', '>=12']
BC = [0, 200, 500, 1000, 2000, 1e9];  RC = ['<200', '200-500', '500-1k', '1k-2k', '>=2k']
BT = [0, 1, 2, 4, 7, 1e9];            RT = ['0', '1', '2-3', '4-6', '>=7']
j['fx_v'] = pd.cut(j.rajada, bins=BW, labels=RW, right=False)
j['fx_r'] = pd.cut(j.chuva_h_max, bins=BH, labels=RH, right=False)
j['fx_c'] = pd.cut(j.cape_max, bins=BC, labels=RC, right=False)

CALMO = (j.chuva_dia < 1) & (j.rajada < 30)
base = j[CALMO].groupby('CodIBGE').chamados.mean().rename('base')
base = base[base > 0]
j = j.join(base, on='CodIBGE').dropna(subset=['base'])
CALMO = (j.chuva_dia < 1) & (j.rajada < 30)
fd = j[CALMO].groupby('dow').chamados.sum() / j[CALMO].groupby('dow').base.sum()
j['fdow'] = j.dow.map(fd)
j['rel'] = (j.chamados - j.base * j.fdow) / j.base


def ajusta(cols):
    X = pd.concat([pd.get_dummies(j[c], prefix=c).drop(columns=['%s_%s' % (c, j[c].cat.categories[0])])
                   for c in cols], axis=1).astype(float)
    w = np.sqrt(j.base.values)
    coef, *_ = np.linalg.lstsq(X.values * w[:, None], j.rel.values * w, rcond=None)
    pred = j.base * j.fdow + j.base * (X.values @ coef)
    r2 = 1 - ((j.chamados - pred) ** 2).sum() / ((j.chamados - j.chamados.mean()) ** 2).sum()
    return np.abs(pred - j.chamados).mean(), (pred - j.chamados).mean(), r2, dict(zip(X.columns, coef))


for R in (10, 15, 25):
    j['fx_t'] = pd.cut(j['raio_h_%d' % R], bins=BT, labels=RT, right=False)
    print('\n=========== raio de %d km ===========' % R)
    print('distribuicao (horas com trovoada perto):',
          {r: int((j.fx_t == r).sum()) for r in RT})
    print('%-40s %8s %8s %9s' % ('modelo', 'MAE', 'vies', 'R2'))
    res = {}
    for nome, cols in [('producao: vento + chuva + CAPE', ['fx_v', 'fx_r', 'fx_c']),
                       ('troca:    vento + TROVOADA + CAPE', ['fx_v', 'fx_t', 'fx_c']),
                       ('soma:     vento + chuva + CAPE + TROVOADA', ['fx_v', 'fx_r', 'fx_c', 'fx_t']),
                       ('so trovoada', ['fx_t'])]:
        mae, vies, r2, co = ajusta(cols)
        res[nome] = co
        print('%-40s %8.3f %+8.3f %9.4f' % (nome, mae, vies, r2))
    co = res['soma:     vento + chuva + CAPE + TROVOADA']
    print('coeficientes de TROVOADA (no modelo com os quatro):')
    for r in RT[1:]:
        print('   %-5s h  %+7.3f   dias=%d' % (r, co.get('fx_t_%s' % r, float('nan')), int((j.fx_t == r).sum())))
    ant = res['producao: vento + chuva + CAPE']
    print('o que acontece com a CHUVA quando a trovoada entra:')
    for r in RH[1:]:
        k = 'fx_r_%s' % r
        print('   chuva %-5s %+7.3f -> %+7.3f' % (r, ant[k], co[k]))
    print('correlacao trovoada x chuva_h_max: %+.3f | x CAPE: %+.3f'
          % (j[['raio_h_%d' % R, 'chuva_h_max']].corr().iloc[0, 1],
             j[['raio_h_%d' % R, 'cape_max']].corr().iloc[0, 1]))
