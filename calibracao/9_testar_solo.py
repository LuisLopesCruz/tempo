# -*- coding: utf-8 -*-
"""D12 — chuva ACUMULADA dos dias anteriores acrescenta algo aos tres drivers?

Uso:  python 9_testar_solo.py

A HIPOTESE
  Os tres drivers de hoje sao todos INSTANTANEOS: rajada agora, chuva horaria
  maxima agora, CAPE agora. Nenhum tem memoria. Mas deslizamento e queda de
  barreira dependem do solo ja estar carregado — do que choveu ANTES, nao do
  que cai hoje. Se isso derruba rede, existe sinal que nenhum dos tres ve.

POR QUE EXCLUIR O DIA DE HOJE DO ACUMULADO
  Incluir hoje faria o driver repetir `chuva_dia`/`chuva_h_max`, que ja estao
  no modelo. O acumulado soma apenas os dias ANTERIORES: assim ele mede
  memoria, que e exatamente a dimensao que falta, e nao intensidade de novo.

DE ONDE VEM CADA COISA
  O driver precisa so do ERA5 (temos 2023-2026). O alvo precisa da ANEEL, e
  so o oc2026.parquet sobrou em disco. Entao o ajuste roda sobre 2026, mas a
  acumulacao usa o fim de 2025 para que os primeiros dias de janeiro tenham
  janela completa — sem isso, as primeiras linhas teriam acumulado truncado.
"""
import json, glob, pandas as pd, numpy as np, pyarrow.parquet as pq

ANO_ALVO = 2026
ANOS_ERA = [2025, 2026]          # 2025 entra so para dar lastro a janela movel

# ------------------------------------------------- ERA5: diario + horario max
linhas, horas = [], []
for ano in ANOS_ERA:
    for f in sorted(glob.glob('era_%d_*.json' % ano),
                    key=lambda x: int(x.rsplit('_', 1)[1].split('.')[0])):
        k = int(f.rsplit('_', 1)[1].split('.')[0])
        ib = [int(x) for x in open('era_%d_%d.ibge' % (ano, k)).read().strip().split(',')]
        js = json.load(open(f, encoding='utf-8'))
        for i, loc in enumerate(js if isinstance(js, list) else [js]):
            dd = loc['daily']
            for jx, dia in enumerate(dd['time']):
                linhas.append((ib[i], dia, dd['precipitation_sum'][jx],
                               dd['wind_gusts_10m_max'][jx]))
            h = loc['hourly']
            s = pd.DataFrame({'t': pd.to_datetime(h['time']), 'p': h['precipitation']})
            for dia, v in s.groupby(s.t.dt.date).p.max().items():
                horas.append((ib[i], str(dia), v))

drv = pd.DataFrame(linhas, columns=['CodIBGE', 'dia', 'chuva_dia', 'rajada'])
inten = pd.DataFrame(horas, columns=['CodIBGE', 'dia', 'chuva_h_max'])
for x in (drv, inten):
    x['dia'] = pd.to_datetime(x.dia).dt.date
drv = drv.drop_duplicates(['CodIBGE', 'dia']).sort_values(['CodIBGE', 'dia'])
print('ERA5: {:,} municipio-dia | {} municipios | {} -> {}'.format(
    len(drv), drv.CodIBGE.nunique(), drv.dia.min(), drv.dia.max()))

# --------------------------------------- acumulado dos dias ANTERIORES (memoria)
for n in (2, 3, 5):
    drv['acum%d' % n] = (drv.groupby('CodIBGE').chuva_dia
                           .transform(lambda s, n=n: s.shift(1).rolling(n, min_periods=n).sum()))

# ------------------------------------------------------------- CAPE do ano alvo
linhas = []
for f in sorted(glob.glob('cape_%d_*.json' % ANO_ALVO)):
    k = f.rsplit('_', 1)[1].split('.')[0]
    ib = [int(x) for x in open('cape_%d_%s.ibge' % (ANO_ALVO, k)).read().strip().split(',')]
    js = json.load(open(f, encoding='utf-8'))
    for i, loc in enumerate(js if isinstance(js, list) else [js]):
        h = loc['hourly']
        s = pd.DataFrame({'t': pd.to_datetime(h['time']), 'c': h['cape']})
        for dia, v in s.groupby(s.t.dt.date).c.max().items():
            linhas.append((ib[i], dia, v))
cp = pd.DataFrame(linhas, columns=['CodIBGE', 'dia', 'cape_max'])
cp['dia'] = pd.to_datetime(cp.dia).dt.date

# ----------------------------------------------------- ALVO: chamados da ANEEL
cols = [c.name for c in pq.ParquetFile('oc%d.parquet' % ANO_ALVO).schema_arrow]
if 'CodMunicipioIBGE' in cols:
    t = pq.read_table('oc%d.parquet' % ANO_ALVO,
                      columns=['CodMunicipioIBGE', 'DthIniOcorrencia'],
                      filters=[('CodMunicipioIBGE', '>=', '3300000'),
                               ('CodMunicipioIBGE', '<=', '3399999')])
    d = t.to_pandas()
    d['CodIBGE'] = pd.to_numeric(d.CodMunicipioIBGE, errors='coerce')
    d = d.dropna(subset=['CodIBGE'])
    d['CodIBGE'] = d.CodIBGE.astype(int)
    d['dia'] = pd.to_datetime(d.DthIniOcorrencia, errors='coerce').dt.date
else:
    t = pq.read_table('oc%d.parquet' % ANO_ALVO,
                      columns=['CodIBGE', 'DthInicioOcorrenciaAberta'],
                      filters=[('CodIBGE', '>=', 3300000), ('CodIBGE', '<=', 3399999)])
    d = t.to_pandas()
    d['dia'] = pd.to_datetime(d.DthInicioOcorrenciaAberta, errors='coerce').dt.date
d = d.dropna(subset=['dia'])
alvo = d.groupby(['CodIBGE', 'dia']).size().reset_index(name='chamados')
print('ANEEL {}: {:,} chamados | {:,} municipio-dia com ocorrencia'.format(
    ANO_ALVO, len(d), len(alvo)))

# ------------------------------------------------------------------- juncao
j = (drv.merge(inten, on=['CodIBGE', 'dia'], how='left')
        .merge(cp,    on=['CodIBGE', 'dia'], how='left')
        .merge(alvo,  on=['CodIBGE', 'dia'], how='left'))
j['chamados'] = j.chamados.fillna(0)
j['ano'] = pd.to_datetime(j.dia).dt.year
j = j[j.ano == ANO_ALVO]                      # so o ano com alvo
j = j[j.dia <= alvo.dia.max()]                # o parquet termina antes do fim do ano
j['dow'] = pd.to_datetime(j.dia).dt.dayofweek
j = j.dropna(subset=['cape_max', 'chuva_h_max', 'acum2', 'acum3', 'acum5'])
print('painel do teste: {:,} municipio-dia | {} -> {}'.format(len(j), j.dia.min(), j.dia.max()))

# ------------------------------------------------------------------- faixas
BW = [0, 30, 40, 50, 60, 70, 1e9];     RW = ['<30', '30-40', '40-50', '50-60', '60-70', '>=70']
BH = [0, 1, 3, 6, 12, 1e9];            RH = ['<1', '1-3', '3-6', '6-12', '>=12']
BC = [0, 200, 500, 1000, 2000, 1e9];   RC = ['<200', '200-500', '500-1k', '1k-2k', '>=2k']
BS = [0, 5, 15, 30, 60, 1e9];          RS = ['<5', '5-15', '15-30', '30-60', '>=60']
j['fx_v'] = pd.cut(j.rajada,      bins=BW, labels=RW, right=False)
j['fx_r'] = pd.cut(j.chuva_h_max, bins=BH, labels=RH, right=False)
j['fx_c'] = pd.cut(j.cape_max,    bins=BC, labels=RC, right=False)
j['fx_s'] = pd.cut(j.acum3,       bins=BS, labels=RS, right=False)

print('\n=== distribuicao do acumulado de 3 dias anteriores (mm) ===')
for r in RS:
    print('  {:7} {:6} dias'.format(r, int((j.fx_s == r).sum())))

# ------------------------------------------------- base, dow, excedente
CALMO = (j.chuva_dia < 1) & (j.rajada < 30)
base = j[CALMO].groupby('CodIBGE').chamados.mean().rename('base')
base = base[base > 0]
j = j.join(base, on='CodIBGE').dropna(subset=['base'])
CALMO = (j.chuva_dia < 1) & (j.rajada < 30)
fd = j[CALMO].groupby('dow').chamados.sum() / j[CALMO].groupby('dow').base.sum()
j['fdow'] = j.dow.map(fd)
j['rel'] = (j.chamados - j.base * j.fdow) / j.base
print('base definida para {} municipios | {:,} linhas no ajuste'.format(
    j.CodIBGE.nunique(), len(j)))


def ajusta(cols):
    X = pd.concat([pd.get_dummies(j[c], prefix=c)
                     .drop(columns=['%s_%s' % (c, j[c].cat.categories[0])])
                   for c in cols], axis=1).astype(float)
    w = np.sqrt(j.base.values)
    coef, *_ = np.linalg.lstsq(X.values * w[:, None], j.rel.values * w, rcond=None)
    pred = j.base * j.fdow + j.base * (X.values @ coef)
    r2 = 1 - ((j.chamados - pred) ** 2).sum() / ((j.chamados - j.chamados.mean()) ** 2).sum()
    return (np.abs(pred - j.chamados).mean(), (pred - j.chamados).mean(), r2,
            dict(zip(X.columns, coef)))


print('\n{:40} {:>8} {:>8} {:>9}'.format('modelo', 'MAE', 'vies', 'R2'))
res = {}
for nome, cols in [('vento + chuva + CAPE  (producao)', ['fx_v', 'fx_r', 'fx_c']),
                   ('  + solo (acum 3 dias)',           ['fx_v', 'fx_r', 'fx_c', 'fx_s']),
                   ('so solo',                          ['fx_s'])]:
    mae, vies, r2, co = ajusta(cols)
    res[nome] = (mae, r2, co)
    print('{:40} {:8.3f} {:+8.3f} {:9.4f}'.format(nome, mae, vies, r2))

print('\n=== coeficientes de SOLO, no modelo com os quatro ===')
co = res['  + solo (acum 3 dias)'][2]
for r in RS[1:]:
    k = 'fx_s_%s' % r
    if k in co:
        print('  solo {:8} {:+7.3f}   dias={:6}'.format(r, co[k], int((j.fx_s == r).sum())))

print('\n=== o que acontece com os tres antigos quando solo entra ===')
ant = res['vento + chuva + CAPE  (producao)'][2]
for pre, rs, rot in [('fx_v', RW[1:], 'vento'), ('fx_r', RH[1:], 'chuva'), ('fx_c', RC[1:], 'CAPE')]:
    for r in rs:
        k = '%s_%s' % (pre, r)
        if k in co and k in ant:
            print('  {:6} {:9} {:+7.3f} -> {:+7.3f}  ({:+.3f})'.format(
                rot, r, ant[k], co[k], co[k] - ant[k]))

print('\n=== correlacao do acumulado com os drivers existentes ===')
cc = j[['acum3', 'chuva_h_max', 'rajada', 'cape_max', 'chuva_dia']].corr()['acum3']
for k, v in cc.items():
    if k != 'acum3':
        print('  acum3 x {:12} {:+.3f}'.format(k, v))

print('\n=== janela: 2, 3 ou 5 dias? ===')
for n in (2, 3, 5):
    j['fx_s'] = pd.cut(j['acum%d' % n], bins=BS, labels=RS, right=False)
    mae, vies, r2, _ = ajusta(['fx_v', 'fx_r', 'fx_c', 'fx_s'])
    print('  acumulado de {} dias: MAE {:.3f} | vies {:+.3f} | R2 {:.4f}'.format(n, mae, vies, r2))
