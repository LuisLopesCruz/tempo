# -*- coding: utf-8 -*-
"""PASSO 2 — painel diario municipio x dia: alvo + drivers.

Uso:  python 2_montar_painel.py 2025 [2026 ...]

ALVO = CHAMADO, nao interrupcao distinta.
  Interrupcao seria fisicamente melhor, mas o id so e registrado em 27% dos
  chamados da Light e 77% dos da Ampla — pratica de registro, nao fisica. Usar
  interrupcao subcontaria a area da Light, que e a capital. Chamado e o unico
  medido igual nas tres distribuidoras.

O ROTULO DE CAUSA NAO E USADO. A distribuidora classifica errado: numa
tempestade, muita queda de arvore entra como falha de equipamento. Dimensionar
pelo rotulo foi o erro da v3 — dava um piso artificial de 7,8% e o modelo nunca
alcancava os dias ruins.
"""
import sys, json, glob, pandas as pd, pyarrow.parquet as pq

anos = sys.argv[1:] or ['2025']
partes = []

for ano in anos:
    # A ANEEL TROCOU O LAYOUT A PARTIR DE 2026. Ate 2025: CodIBGE (int),
    # DthInicioOcorrenciaAberta. De 2026: CodMunicipioIBGE e DthIniOcorrencia,
    # com TODAS as colunas como texto. Nao assuma schema estavel entre anos.
    cols = [c.name for c in pq.ParquetFile(f'oc{ano}.parquet').schema_arrow]
    if 'CodMunicipioIBGE' in cols:                       # layout novo (>= 2026)
        t = pq.read_table(f'oc{ano}.parquet',
            columns=['CodMunicipioIBGE','NomAgente','DthIniOcorrencia'],
            filters=[('CodMunicipioIBGE','>=','3300000'),
                     ('CodMunicipioIBGE','<=','3399999')])
        d = t.to_pandas()
        d['CodIBGE'] = pd.to_numeric(d.CodMunicipioIBGE, errors='coerce')
        d = d.dropna(subset=['CodIBGE'])
        d['CodIBGE'] = d.CodIBGE.astype(int)
        d['dia'] = pd.to_datetime(d.DthIniOcorrencia, errors='coerce').dt.date
    else:                                                # layout antigo (<= 2025)
        t = pq.read_table(f'oc{ano}.parquet',
            columns=['CodIBGE','NomAgente','DthInicioOcorrenciaAberta'],
            filters=[('CodIBGE','>=',3300000),('CodIBGE','<=',3399999)])
        d = t.to_pandas()
        d['dia'] = pd.to_datetime(d.DthInicioOcorrenciaAberta, errors='coerce').dt.date
    d = d.dropna(subset=['dia'])
    # COBERTURA DA ANEEL. O tempo (ERA5) vai ate ~6 dias atras; a ANEEL, ate o
    # ultimo mes publicado. Dia com tempo e sem ANEEL entraria como "zero
    # chamados" — dia calmo falso, que puxa o modelo para baixo (em 11/09 eram
    # 5 dias; com setembro e o tempo ate novembro seriam ~40). O fim vale pelo
    # ultimo mes com volume normal (>= metade da mediana mensal): a data de
    # inicio tem erros de digitacao que vao ate 2026-12 e nao servem de limite.
    d['mes'] = pd.to_datetime(d.dia).dt.to_period('M')
    por_mes = d.groupby('mes').size()
    cheio = por_mes[por_mes >= 0.5 * por_mes.median()]
    fim_aneel = cheio.index.max().to_timestamp(how='end').date()
    d = d[d.dia <= fim_aneel]
    print(f'{ano}: ANEEL cobre ate {fim_aneel}')
    alvo = d.groupby(['CodIBGE','dia']).size().reset_index(name='chamados')
    print(f'{ano}: {len(d):,} chamados no RJ, {len(alvo):,} municipio-dia')

    linhas, horas = [], []
    for f in sorted(glob.glob(f'era_{ano}_*.json'),
                    key=lambda x: int(x.rsplit('_',1)[1].split('.')[0])):
        k = int(f.rsplit('_',1)[1].split('.')[0])
        ib = [int(x) for x in open(f'era_{ano}_{k}.ibge').read().strip().split(',')]
        js = json.load(open(f, encoding='utf-8'))
        for i, loc in enumerate(js if isinstance(js, list) else [js]):
            dd = loc['daily']
            for j, dia in enumerate(dd['time']):
                linhas.append((ib[i], dia, dd['precipitation_sum'][j], dd['wind_gusts_10m_max'][j]))
            h = loc['hourly']
            s = pd.DataFrame({'t': pd.to_datetime(h['time']), 'p': h['precipitation']})
            for dia, v in s.groupby(s.t.dt.date).p.max().items():
                horas.append((ib[i], str(dia), v))

    drv   = pd.DataFrame(linhas, columns=['CodIBGE','dia','chuva_dia','rajada'])
    inten = pd.DataFrame(horas,  columns=['CodIBGE','dia','chuva_h_max'])
    for x in (drv, inten):
        x['dia'] = pd.to_datetime(x.dia).dt.date
    j = (drv.merge(inten, on=['CodIBGE','dia'], how='left')
            .merge(alvo,  on=['CodIBGE','dia'], how='left'))
    j = j[j.dia <= fim_aneel]                      # so dia que a ANEEL cobre
    j['chamados'] = j.chamados.fillna(0)
    j['ano'] = int(ano)
    partes.append(j)

p = pd.concat(partes, ignore_index=True)

# CAPE, se ja tiver sido baixado (5_baixar_cape.sh). Nao vem do ERA5 — o
# arquivo de reanalise devolve CAPE todo nulo. Vem do historical-forecast-api,
# que arquiva o que os modelos PREVIRAM: a mesma regua que producao usa.
cape_files = sorted(glob.glob('cape_*.json'))
if cape_files:
    linhas = []
    for f in cape_files:
        ano_c = f.split('_')[1]; k = f.rsplit('_',1)[1].split('.')[0]
        ib = [int(x) for x in open(f'cape_{ano_c}_{k}.ibge').read().strip().split(',')]
        js = json.load(open(f, encoding='utf-8'))
        for i, loc in enumerate(js if isinstance(js, list) else [js]):
            h = loc['hourly']
            sc = pd.DataFrame({'t': pd.to_datetime(h['time']), 'c': h['cape']})
            for dia, v in sc.groupby(sc.t.dt.date).c.max().items():
                linhas.append((ib[i], dia, v))
    cp = pd.DataFrame(linhas, columns=['CodIBGE','dia','cape_max'])
    p = p.merge(cp, on=['CodIBGE','dia'], how='left')
    print(f'CAPE anexado: {int(p.cape_max.notna().sum()):,} de {len(p):,} linhas')
else:
    print('CAPE ausente (rode 5_baixar_cape.sh para incluir o terceiro driver)')

p['dow'] = pd.to_datetime(p.dia).dt.dayofweek
p.to_parquet('painel.parquet')
print(f'\npainel.parquet: {len(p):,} linhas | {p.CodIBGE.nunique()} municipios | anos {sorted(p.ano.unique())}')
print('drivers ausentes:', int(p.chuva_h_max.isna().sum()))
print('\nProximo passo: python 3_ajustar_v4.py')
