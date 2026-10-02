# -*- coding: utf-8 -*-
"""D11 — CAPE bate a intensidade de chuva como driver de descarga atmosferica?

Uso:  python 6_testar_cape.py     (precisa de painel.parquet e cape_*.json)

O TESTE
  A camada 3 usa `chuva_h_max` como driver do termo de raio, por falta de coisa
  melhor: CAPE nao existe no arquivo ERA5. Mas existe no arquivo de PREVISOES
  passadas da Open-Meteo, e e ate a regua mais honesta — em producao o sistema
  consome previsao, nao reanalise.

  Aqui os dois competem na mesma estrutura, mesmo numero de faixas, mesmos
  dados: so muda o driver do termo de raio. Vence quem errar menos.

  Tambem se testa os DOIS JUNTOS: se cada um carregar informacao que o outro
  nao tem, somar e melhor que escolher.
"""
import json, glob, pandas as pd, numpy as np

j = pd.read_parquet('painel.parquet')

# --- CAPE diario: maximo do dia, que e o analogo de chuva_h_max -------------
linhas = []
for f in sorted(glob.glob('cape_*.json')):
    ano = f.split('_')[1]
    k = f.rsplit('_', 1)[1].split('.')[0]
    ib = [int(x) for x in open(f'cape_{ano}_{k}.ibge').read().strip().split(',')]
    js = json.load(open(f, encoding='utf-8'))
    for i, loc in enumerate(js if isinstance(js, list) else [js]):
        h = loc['hourly']
        s = pd.DataFrame({'t': pd.to_datetime(h['time']), 'c': h['cape']})
        g = s.groupby(s.t.dt.date).c.agg(['max', 'mean'])
        for dia, r in g.iterrows():
            linhas.append((ib[i], dia, r['max'], r['mean']))

cp = pd.DataFrame(linhas, columns=['CodIBGE', 'dia', 'cape_max', 'cape_med'])
j = j.merge(cp, on=['CodIBGE', 'dia'], how='left')
print(f'painel: {len(j):,} linhas | sem CAPE: {int(j.cape_max.isna().sum()):,}')
j = j.dropna(subset=['cape_max'])

BW = [0,30,40,50,60,70,1e9]; RW = ['<30','30-40','40-50','50-60','60-70','>=70']
BH = [0,1,3,6,12,1e9];       RH = ['<1','1-3','3-6','6-12','>=12']
BC = [0,200,500,1000,2000,1e9]; RC = ['<200','200-500','500-1k','1k-2k','>=2k']
j['fx_v'] = pd.cut(j.rajada,      bins=BW, labels=RW, right=False)
j['fx_r'] = pd.cut(j.chuva_h_max, bins=BH, labels=RH, right=False)
j['fx_c'] = pd.cut(j.cape_max,    bins=BC, labels=RC, right=False)

CALMO = (j.chuva_dia < 1) & (j.rajada < 30)
base = j[CALMO].groupby(['CodIBGE','ano']).chamados.mean().rename('base')
base = base[base > 0]
j = j.join(base, on=['CodIBGE','ano']).dropna(subset=['base'])
CALMO = (j.chuva_dia < 1) & (j.rajada < 30)
fd = j[CALMO].groupby('dow').chamados.sum() / j[CALMO].groupby('dow').base.sum()
j['fdow'] = j.dow.map(fd)
j['rel'] = (j.chamados - j.base*j.fdow) / j.base

def ajusta(cols):
    X = pd.concat([pd.get_dummies(j[c], prefix=c)
                     .drop(columns=[f'{c}_{j[c].cat.categories[0]}'])
                   for c in cols], axis=1).astype(float)
    w = np.sqrt(j.base.values)
    coef, *_ = np.linalg.lstsq(X.values*w[:,None], j.rel.values*w, rcond=None)
    pred = j.base*j.fdow + j.base*(X.values @ coef)
    return (np.abs(pred-j.chamados).mean(), (pred-j.chamados).mean(),
            1 - ((j.chamados-pred)**2).sum()/((j.chamados-j.chamados.mean())**2).sum(),
            dict(zip(X.columns, coef)))

print(f'\n{"modelo":38} {"MAE":>8} {"vies":>8} {"R2":>8}')
res = {}
for nome, cols in [('vento + chuva_h_max  (atual)', ['fx_v','fx_r']),
                   ('vento + CAPE',                 ['fx_v','fx_c']),
                   ('vento + chuva + CAPE',         ['fx_v','fx_r','fx_c']),
                   ('so vento',                     ['fx_v'])]:
    mae, vies, r2, co = ajusta(cols)
    res[nome] = (mae, r2, co)
    print(f'{nome:38} {mae:8.3f} {vies:+8.3f} {r2:8.4f}')

print('\n=== coeficientes de CAPE, no modelo com os dois ===')
co = res['vento + chuva + CAPE'][2]
for r in RC[1:]:
    k = f'fx_c_{r}'
    if k in co: print(f'  CAPE {r:9} {co[k]:+7.3f}   dias={int((j.fx_c==r).sum()):6}')
print('=== e os de chuva, no mesmo modelo ===')
for r in RH[1:]:
    k = f'fx_r_{r}'
    if k in co: print(f'  chuva {r:8} {co[k]:+7.3f}   dias={int((j.fx_r==r).sum()):6}')

print('\n=== correlacao entre os dois drivers ===')
print(f'  cape_max x chuva_h_max: {j[["cape_max","chuva_h_max"]].corr().iloc[0,1]:+.3f}')
