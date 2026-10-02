# -*- coding: utf-8 -*-
"""PASSO 7 (diagnostico) — ate que mes o arquivo da ANEEL ja cobre?

Uso:  python 7_espiar_aneel.py [ano]      (padrao: ano corrente)

POR QUE EXISTE
  A verificacao da camada 3 so pode rodar quando a ANEEL publica um arquivo que
  cobra os dias que ja tem previsao congelada em tempo.impacto_previsto. Saber
  isso exigia baixar 195 MB — ou nao exigia: o rodape do parquet guarda
  estatisticas min/max por coluna, e o servidor da ANEEL aceita HTTP Range.
  Este script le so o rodape. Medido em 2026-10-02: **149 KB** em vez de 195 MB.

O QUE OLHAR
  NumMesCompetencia max  -> ate que mes de competencia o arquivo vai.
                            Em 2026-10-02 dava 8: o arquivo publicado em 10/09
                            cobria ate agosto, e as previsoes congeladas
                            comecam em 11/09. Por isso zero pares verificados.

  DthIniOcorrencia max   -> vem sujo (ja apareceu 2026-12-02, e DthFim com
                            2029). Sao erros de digitacao das distribuidoras.
                            Nao use essa data como criterio de corte; o
                            4_carregar_observado.py carrega tudo e deixa o SQL
                            filtrar pelos dias que tinham previsao, o que e
                            imune a isso.
"""
import io, sys, json, urllib.request

PACOTE = "ced06b4c-45a5-4cae-8a7e-f576ffc3b412"   # ocorrencias-emergenciais-nas-redes-de-distribuicao
# ATENCAO: nao confundir com ccb25653-f07b-4f28-84c2-62a89d1f5a56
# (interrupcoes-de-energia-eletrica), que e OUTRO dataset — o do D10, com
# unidades consumidoras afetadas. Os dois tem 21 recursos e nomes parecidos.
API = "https://dadosabertos.aneel.gov.br/api/3/action/package_show?id=" + PACOTE
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

ano = sys.argv[1] if len(sys.argv) > 1 else "2026"


def buscar(url, **cab):
    cab.setdefault("User-Agent", UA)
    return urllib.request.urlopen(urllib.request.Request(url, headers=cab), timeout=90)


class ArquivoRemoto(io.RawIOBase):
    """File-like sobre HTTP Range: o pyarrow so pede o rodape."""

    def __init__(self, url, tamanho):
        self.url, self.tamanho, self.pos, self.baixado = url, tamanho, 0, 0

    def readable(self):  return True
    def seekable(self):  return True
    def tell(self):      return self.pos

    def seek(self, pos, whence=0):
        self.pos = pos if whence == 0 else (self.pos + pos if whence == 1 else self.tamanho + pos)
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.tamanho - self.pos
        if n == 0:
            return b""
        fim = min(self.pos + n, self.tamanho) - 1
        dados = buscar(self.url, Range="bytes=%d-%d" % (self.pos, fim)).read()
        self.pos += len(dados)
        self.baixado += len(dados)
        return dados


pacote = json.load(buscar(API))["result"]
alvo = next((r for r in pacote["resources"]
             if (r.get("format") or "").upper() == "PARQUET" and ano in (r.get("name") or "")), None)
if alvo is None:
    sys.exit("nao achei o parquet de %s no pacote" % ano)

print("recurso      %s" % alvo["name"])
print("publicado em %s" % alvo["last_modified"])

tamanho = int(buscar(alvo["url"]).headers["Content-Length"])

import pyarrow.parquet as pq
f = ArquivoRemoto(alvo["url"], tamanho)
md = pq.ParquetFile(f).metadata
nomes = [md.schema.column(i).name for i in range(md.num_columns)]

print("linhas       {:,}".format(md.num_rows))
print()
for col in ("NumAnoCompetencia", "NumMesCompetencia", "DthIniOcorrencia"):
    if col not in nomes:
        continue
    i = nomes.index(col)
    mn = mx = None
    for g in range(md.num_row_groups):
        st = md.row_group(g).column(i).statistics
        if st is None or not st.has_min_max:
            continue
        mn = st.min if mn is None or st.min < mn else mn
        mx = st.max if mx is None or st.max > mx else mx
    print("  %-20s min=%s  max=%s" % (col, mn, mx))

print()
print("baixado: %.0f KB de %.0f MB" % (f.baixado / 1024, tamanho / 1e6))
