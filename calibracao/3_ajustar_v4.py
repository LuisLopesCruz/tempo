# -*- coding: utf-8 -*-
"""PASSO 3 — ajusta a camada 3 (modelo v4) e emite o SQL para aplicar.

Uso:  python 3_ajustar_v4.py     (le painel.parquet, escreve v4.sql)

MODELO
  total_esperado = base * fator_dow + base * (b_vento(rajada) + b_raio(chuva_h_max))

  Vento e descarga sao mecanismos distintos, cada um contra o seu proprio
  driver, e os efeitos SOMAM — nunca multiplicam um pelo outro.

  Os b sao ajustados contra o EXCEDENTE OBSERVADO DO TOTAL diario, numa
  regressao CONJUNTA (as duas faixas na mesma regressao, o que separa a
  contribuicao de cada driver sem dupla contagem). Nada aqui olha o rotulo
  de causa da distribuidora.

O QUE VERIFICAR NA SAIDA
  - b monotonico nas duas tabelas (faixa maior => b maior). Se quebrar, a
    faixa provavelmente tem poucos dias: confira a coluna 'dias'.
  - vies perto de zero.
  - alcance: quantos municipios o teto do modelo cobre o proprio p95.
    Na calibracao de 2025 deu 19 de 92. Se cair muito, algo regrediu.
  - curva de probabilidade monotonica e terminando bem acima de 10%
    (10% e a climatologia: sem ela o modelo nao informa nada).
"""
import pandas as pd, numpy as np, io

j = pd.read_parquet('painel.parquet')
BW = [0,30,40,50,60,70,1e9]; RW = ['<30','30-40','40-50','50-60','60-70','>=70']
BH = [0,1,3,6,12,1e9];       RH = ['<1','1-3','3-6','6-12','>=12']
BC = [0,200,500,1000,2000,1e9]; RC = ['<200','200-500','500-1k','1k-2k','>=2k']
j['fx_v'] = pd.cut(j.rajada,      bins=BW, labels=RW, right=False)
j['fx_r'] = pd.cut(j.chuva_h_max, bins=BH, labels=RH, right=False)

# TERCEIRO DRIVER: CAPE, quando o painel o traz.
# Medido em 2026-09-11 sobre 123.648 municipio-dia: CAPE sozinho NAO bate a
# intensidade de chuva (MAE 9,063 contra 9,035). Mas os dois JUNTOS batem os
# dois sozinhos (8,971) e zeram o vies (-0,227 -> +0,034), porque carregam
# informacao diferente — a correlacao entre eles e so +0,33. Parte do que a
# chuva media era conveccao disfarcada: os coeficientes de chuva caem quando
# o CAPE entra.
USA_CAPE = 'cape_max' in j.columns and j.cape_max.notna().mean() > 0.95
if USA_CAPE:
    j['fx_c'] = pd.cut(j.cape_max, bins=BC, labels=RC, right=False)
    j = j.dropna(subset=['cape_max'])
    print('CAPE presente: modelo com TRES drivers (vento + chuva + conveccao)')
else:
    print('CAPE ausente: modelo com dois drivers')

# BASE POR (MUNICIPIO, ANO), nao por municipio.
# O nivel de chamados muda muito entre anos: em dia calmo, 2023 esta em 77% de
# 2025 e 2024 em 90%. Com base unica, essa tendencia anual entraria no modelo
# disfarcada de efeito do tempo — 2023 teria "excedente negativo" cronico e
# 2025 excedente positivo, sem que chuva nenhuma explicasse.
# Com base por ano, os coeficientes saem so da variacao DENTRO de cada ano.
CALMO = (j.chuva_dia < 1) & (j.rajada < 30)
base_ay = j[CALMO].groupby(['CodIBGE','ano']).chamados.mean().rename('base')
base_ay = base_ay[base_ay > 0]
j = j.join(base_ay, on=['CodIBGE','ano']).dropna(subset=['base'])
CALMO = (j.chuva_dia < 1) & (j.rajada < 30)   # reindexa apos o join

# O NIVEL que vai para producao vem do ano COMPLETO mais recente: ele precisa
# refletir a operacao de hoje e um ciclo anual inteiro, e ano em curso ainda
# nao tem outubro-dezembro. Os COEFICIENTES, esses vem de todos os anos.
dias_por_ano = j.groupby('ano').dia.nunique()
ANO_BASE = int(dias_por_ano[dias_por_ano >= 360].index.max())
base_prod = base_ay.xs(ANO_BASE, level='ano')
print(f'dias por ano: {dias_por_ano.to_dict()}')
print(f'base de producao: ano {ANO_BASE} ({len(base_prod)} municipios)')

fd = j[CALMO].groupby('dow').chamados.sum() / j[CALMO].groupby('dow').base.sum()
j['fdow'] = j.dow.map(fd)
j['excedente'] = j.chamados - j.base * j.fdow
j['rel'] = j.excedente / j.base

Xv = pd.get_dummies(j.fx_v, prefix='v')[[f'v_{r}' for r in RW[1:]]]
Xr = pd.get_dummies(j.fx_r, prefix='r')[[f'r_{r}' for r in RH[1:]]]
blocos = [Xv, Xr]
if USA_CAPE:
    Xc = pd.get_dummies(j.fx_c, prefix='c')[[f'c_{r}' for r in RC[1:]]]
    blocos.append(Xc)
X  = pd.concat(blocos, axis=1).astype(float).values
w  = np.sqrt(j.base.values)            # municipio grande tem mais sinal
coef, *_ = np.linalg.lstsq(X * w[:,None], j.rel.values * w, rcond=None)
nv, nr = len(RW)-1, len(RH)-1
bv = dict(zip(RW[1:], coef[:nv]));        bv[RW[0]] = 0.0
br = dict(zip(RH[1:], coef[nv:nv+nr]));   br[RH[0]] = 0.0
if USA_CAPE:
    bc = dict(zip(RC[1:], coef[nv+nr:])); bc[RC[0]] = 0.0
else:
    bc = {r: 0.0 for r in RC}

print('=== b_vento (acrescimo relativo a base) ===')
for r in RW: print(f'  {r:7} {bv[r]:+7.3f}   dias={int((j.fx_v==r).sum()):6}')
print('=== b_raio ===')
for r in RH: print(f'  {r:7} {br[r]:+7.3f}   dias={int((j.fx_r==r).sum()):6}')
if USA_CAPE:
    print('=== b_conveccao (CAPE maximo do dia) ===')
    for r in RC: print(f'  {r:8} {bc[r]:+7.3f}   dias={int((j.fx_c==r).sum()):6}')

termo = j.fx_v.map(bv).astype(float) + j.fx_r.map(br).astype(float)
if USA_CAPE: termo = termo + j.fx_c.map(bc).astype(float)
j['prev'] = j.base*j.fdow + j.base*termo
mae  = np.abs(j.prev - j.chamados).mean(); vies = (j.prev - j.chamados).mean()
mae0 = np.abs(j.base*j.fdow - j.chamados).mean()
print(f'\nMAE {mae:.2f} (so base: {mae0:.2f}) | vies {vies:+.2f}')

# Alcance medido DENTRO do ano de producao: base e p95 tem de ser do mesmo ano,
# senao a conta mistura niveis diferentes e o numero nao quer dizer nada.
jb   = j[j.ano == ANO_BASE]
teto = base_prod*max(fd) + base_prod*(max(bv.values())+max(br.values())+max(bc.values()))
p95  = jb.groupby('CodIBGE').chamados.quantile(.95)
teto, p95 = teto.align(p95, join='inner')
print(f'alcance: {int((teto>=p95).sum())} de {len(p95)} municipios atingem o proprio p95'
      f' | teto medio = {round((100*teto/p95).mean())}% do p95')

# --- probabilidade de dia ruim (top 10% do municipio) ---------------------
j['rel_obs']  = j.chamados / j.base
j['rel_prev'] = j.prev / j.base
lim = j.rel_obs.quantile(.90)
j['ruim'] = (j.rel_obs >= lim).astype(int)
faixas = [0,1.0,1.1,1.2,1.3,1.4,1.6,9]
j['fp'] = pd.cut(j.rel_prev, faixas)
pr = j.groupby('fp', observed=True).agg(dias=('ruim','size'), prob=('ruim','mean'))
print(f'\n=== probabilidade de dia ruim (rel >= {lim:.2f}; climatologia = 10%) ===')
print((pr.assign(prob=(100*pr.prob).round(1))).to_string())

with io.open('v4.sql','w',encoding='utf-8') as f:
    f.write('-- gerado por 3_ajustar_v4.py\n')
    anos_lst = sorted(int(a) for a in j.ano.unique())
    f.write(f'-- anos {anos_lst} | {len(j):,} municipio-dia | vies {vies:+.2f}\n\n')
    f.write('truncate tempo.impacto_coef_v4;\ninsert into tempo.impacto_coef_v4 '
            '(causa,driver,faixa,minimo,maximo,b,n_dias) values\n')
    linhas = []
    for (a,b_),r in zip(list(zip(BW[:-1],BW[1:])), RW):
        mx = 'null' if b_ >= 1e8 else str(int(b_))
        linhas.append(f"('vento','rajada_kmh','{r}',{int(a)},{mx},{bv[r]:.4f},{int((j.fx_v==r).sum())})")
    for (a,b_),r in zip(list(zip(BH[:-1],BH[1:])), RH):
        mx = 'null' if b_ >= 1e8 else str(int(b_))
        linhas.append(f"('raio','chuva_h_max_mm','{r}',{int(a)},{mx},{br[r]:.4f},{int((j.fx_r==r).sum())})")
    if USA_CAPE:
        for (a,b_),r in zip(list(zip(BC[:-1],BC[1:])), RC):
            mx = 'null' if b_ >= 1e8 else str(int(b_))
            linhas.append(f"('conveccao','cape_jkg','{r}',{int(a)},{mx},{bc[r]:.4f},{int((j.fx_c==r).sum())})")
    f.write(',\n'.join(linhas) + ';\n\n')
    f.write('truncate tempo.impacto_prob_v4;\ninsert into tempo.impacto_prob_v4 '
            '(rel_min,rel_max,prob,n_dias) values\n')
    pl = []
    for iv, row in pr.iterrows():
        hi = 'null' if iv.right >= 9 else f'{iv.right:.1f}'
        pl.append(f'({iv.left:.1f},{hi},{row.prob:.4f},{int(row.dias)})')
    f.write(',\n'.join(pl) + ';\n\n')
    f.write('truncate tempo.impacto_dow;\ninsert into tempo.impacto_dow (dow,fator) values\n')
    f.write(','.join(f'({(int(d)+1)%7},{v:.4f})' for d, v in fd.items()) + '\n')
    f.write('on conflict (dow) do update set fator = excluded.fator;\n\n')
    f.write(f'-- base por municipio — nivel do ano {ANO_BASE} (ano COMPLETO mais recente).\n')
    f.write('-- Coeficientes vem de todos os anos; o NIVEL vem de um ano so.\n')
    f.write('update tempo.impacto_baseline b set base_total = v.base from (values\n')
    f.write(',\n'.join(f'({int(i)},{v:.2f})' for i, v in base_prod.items()))
    f.write('\n) as v(ibge,base) where b.municipio_ibge = v.ibge;\n\n')
    f.write("-- marca a fonte como ja calibrada, para o vigia de quarta nao acusar falso positivo\n")
    f.write("update tempo.fonte_externa set calibrado_em = now()\n"
            " where fonte='aneel_ocorrencias' and rotulo in ("
            + ','.join(f"'{a}'" for a in anos_lst) + ");\n")
print('\nv4.sql escrito. Aplique com apply_migration e confira o painel depois.')
