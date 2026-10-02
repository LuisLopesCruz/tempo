# -*- coding: utf-8 -*-
"""PASSO 4 — carrega o OBSERVADO da ANEEL para verificar o que foi previsto.

Uso:  python 4_carregar_observado.py 2026 [2027 ...]

Gera observado.sql com a contagem de chamados por (municipio, dia). Isso e o
outro lado da conta: tempo.impacto_previsto guarda o que o painel disse,
tempo.impacto_observado guarda o que aconteceu, e tempo.impacto_pontuar()
compara.

POR QUE ESTE PASSO E SEPARADO DA CALIBRACAO
  Calibrar e ajustar o modelo ao passado. Verificar e conferir se a previsao
  que foi ao ar acertou. Usar o mesmo dado para as duas coisas seria medir o
  modelo com a propria regua: por isso a verificacao so vale para dias que
  JA TINHAM previsao congelada quando o dado da ANEEL chegou.

  O script nao tem como saber quais dias sao esses, entao carrega tudo e deixa
  o SQL filtrar: so entram dias que existem em tempo.impacto_previsto.
"""
import sys, pandas as pd, pyarrow.parquet as pq, io

anos = sys.argv[1:]
if not anos:
    print('uso: python 4_carregar_observado.py 2026 [2027 ...]'); raise SystemExit(1)

partes = []
for ano in anos:
    cols = [c.name for c in pq.ParquetFile(f'oc{ano}.parquet').schema_arrow]
    if 'CodMunicipioIBGE' in cols:                      # layout de 2026 em diante
        t = pq.read_table(f'oc{ano}.parquet',
            columns=['CodMunicipioIBGE','DthIniOcorrencia'],
            filters=[('CodMunicipioIBGE','>=','3300000'),('CodMunicipioIBGE','<=','3399999')])
        d = t.to_pandas()
        d['ibge'] = pd.to_numeric(d.CodMunicipioIBGE, errors='coerce')
        d['dia'] = pd.to_datetime(d.DthIniOcorrencia, errors='coerce').dt.date
    else:
        t = pq.read_table(f'oc{ano}.parquet',
            columns=['CodIBGE','DthInicioOcorrenciaAberta'],
            filters=[('CodIBGE','>=',3300000),('CodIBGE','<=',3399999)])
        d = t.to_pandas().rename(columns={'CodIBGE':'ibge'})
        d['dia'] = pd.to_datetime(d.DthInicioOcorrenciaAberta, errors='coerce').dt.date
    d = d.dropna(subset=['ibge','dia'])
    d['ibge'] = d.ibge.astype(int)
    partes.append(d.groupby(['ibge','dia']).size().reset_index(name='chamados'))
    print(f'{ano}: ate {d.dia.max()}')

g = pd.concat(partes, ignore_index=True)
print(f'\n{len(g):,} municipio-dia | {g.dia.min()} a {g.dia.max()}')

vals = ',\n'.join(f"({int(r.ibge)},'{r.dia}',{int(r.chamados)})" for r in g.itertuples())
with io.open('observado.sql','w',encoding='utf-8') as f:
    f.write('-- gerado por 4_carregar_observado.py\n')
    f.write(f'-- anos {anos} | {g.dia.min()} a {g.dia.max()}\n\n')
    f.write('create temporary table _obs(ibge int, dia date, chamados int);\n')
    f.write('insert into _obs values\n' + vals + ';\n\n')
    f.write('-- so entram dias que TINHAM previsao congelada: verificar contra dia\n')
    f.write('-- sem previsao gravada nao verifica nada, so infla a amostra.\n')
    f.write('insert into tempo.impacto_observado (ponto_id, dia, chamados)\n'
            'select p.id, o.dia, o.chamados\n'
            '  from _obs o\n'
            '  join tempo.ponto p on p.municipio_ibge = o.ibge and p.principal\n'
            ' where exists (select 1 from tempo.impacto_previsto ip\n'
            '                where ip.ponto_id = p.id and ip.dia = o.dia)\n'
            'on conflict (ponto_id, dia) do update set chamados = excluded.chamados,\n'
            '                                          carregado_em = now();\n\n')
    f.write('select * from tempo.impacto_pontuar();\n')
print('observado.sql escrito. Aplique e confira o skill por antecedencia.')
