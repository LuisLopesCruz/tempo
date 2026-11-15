# -*- coding: utf-8 -*-
"""PASSO 8 — sincroniza o observado da ANEEL. Roda A MAO, daqui.

Uso:  TEMPO_ANON_KEY=... TEMPO_INGESTAO_SEGREDO=... python 8_sincronizar_aneel.py

Era um robo diario no GitHub (.github/workflows/aneel.yml). Apagado em 15/11/2026
a pedido do usuario ("se nao funciona, melhor apagar"): desde 11/11 o site da
ANEEL derruba toda conexao vinda das maquinas do GitHub, e daqui baixa na hora.
Cada execucao grava em tempo.aneel_arquivo ate que mes o arquivo publicado vai
(sql/103); o rodape do painel avisa quando ha dado publicado e nao incorporado.
A ANEEL publica com ~2 meses de atraso (setembro saiu em 12/11).

A IDEIA
  O parquet da ANEEL tem ~195 MB e so muda uma vez por mes. Baixar todo dia
  seria desperdicio; nao olhar seria esperar para sempre (foi o que aconteceu
  entre 11/09 e 02/10/2026, com 25 dias congelados e zero conferidos).

  Entao: 29 dias por mes isto custa **149 KB** — o rodape do parquet, lido por
  HTTP Range, que diz ate que mes de competencia o arquivo vai. So quando esse
  mes alcanca algum dia com previsao congelada e que vale baixar as duas
  colunas que importam (~54 MB, ~4 min) e mandar a contagem para o banco.

POR QUE SO DUAS COLUNAS
  Parquet e colunar. CodMunicipioIBGE + DthIniOcorrencia sao 12,3% do arquivo.
  Medido em 2026-10-02: 54 MB contra 195. Pular row groups sem RJ nao ajuda —
  32 dos 34 cobrem o Brasil inteiro, o arquivo nao e ordenado por municipio.

O QUE ELE NAO FAZ
  Nao decide o que e dia valido para verificacao. Manda e deixa o servidor
  filtrar: so entra dia que ja tinha previsao congelada (regra da 10.1, que
  precisa morar onde nao da para burlar).

  Nao fala com Edge Function nenhuma: chama a funcao do banco direto pelo
  PostgREST, com a anon key e um segredo proprio desta porta. Uma chamada, dois
  secrets no GitHub, zero deploy.
"""
import io, os, json, sys, time, urllib.request

PACOTE = "ced06b4c-45a5-4cae-8a7e-f576ffc3b412"   # ocorrencias-emergenciais (NAO e o das interrupcoes)
CKAN = "https://dadosabertos.aneel.gov.br/api/3/action/package_show?id=" + PACOTE
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

SUPA = os.environ.get("TEMPO_SUPABASE_URL", "https://hmwevcpcelmwnonbeojy.supabase.co")
ANON = os.environ.get("TEMPO_ANON_KEY", "")
SEGREDO = os.environ.get("TEMPO_INGESTAO_SEGREDO", "")


def buscar(url, dados=None, **cab):
    # O site da ANEEL derruba conexao vinda do GitHub de vez em quando: 11/11
    # (SSL EOF) e 13/11 (timeout), as duas na PRIMEIRA consulta — e no 13/11 o
    # arquivo com setembro tinha acabado de sair. Sem nova tentativa, uma falha
    # de rede adiava tudo para o dia seguinte. Agora: 4 tentativas, 30/60/90 s.
    cab.setdefault("User-Agent", UA)
    for tentativa in range(4):
        try:
            req = urllib.request.Request(url, data=dados, headers=cab)
            return urllib.request.urlopen(req, timeout=180)
        except urllib.error.HTTPError as e:
            # resposta do servidor (400, 401, 500...): nao e rede, repetir nao
            # adianta. Mostra a mensagem — sem isso so se via "Bad Request".
            print("  HTTP %s em %s: %s" % (e.code, url.split("?")[0][-60:], e.read().decode(errors="replace")[:500]))
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if tentativa == 3:
                raise
            print("  rede falhou (%s), nova tentativa em %d s" % (str(e)[:80], 30 * (tentativa + 1)))
            time.sleep(30 * (tentativa + 1))


class ArquivoRemoto(io.RawIOBase):
    """File-like sobre HTTP Range: o pyarrow pede so o que precisa."""

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


def enviar(linhas):
    """Chama a funcao do banco. Com lista vazia, serve de BATIMENTO.

    O robo roda todo dia e 29 dias por mes nao tem nada a ingerir. Sem esta
    chamada ele nao deixaria rastro nenhum no sistema, e morrer calado seria
    indetectavel — lembrando que o GitHub desativa workflow agendado apos 60
    dias sem atividade no repositorio. Alguns bytes por dia sao a diferenca
    entre "esta esperando" e "parou".
    """
    corpo = json.dumps({"p_segredo": SEGREDO, "p_rows": linhas}).encode()
    r = buscar(SUPA + "/rest/v1/rpc/tempo_ingerir_observado", dados=corpo,
               apikey=ANON, Authorization="Bearer " + ANON,
               **{"Content-Type": "application/json"})
    return r.read().decode()[:300]


def registrar_arquivo(ano, mes, publicado):
    """Grava no banco ate que mes o arquivo da ANEEL vai: alimenta o aviso do rodape."""
    import calendar
    fim = "%d-%02d-%02d" % (ano, mes, calendar.monthrange(ano, mes)[1])
    corpo = json.dumps({"p_segredo": SEGREDO, "p_arquivo_ate": fim,
                        "p_publicado_em": (publicado or "")[:10] or None}).encode()
    buscar(SUPA + "/rest/v1/rpc/tempo_aneel_arquivo", dados=corpo,
           apikey=ANON, Authorization="Bearer " + ANON,
           **{"Content-Type": "application/json"}).read()
    print("registrado no banco: ANEEL publicou ate %s" % fim)


def estado_do_banco():
    r = buscar(SUPA + "/rest/v1/tempo_aneel_estado?select=*",
               apikey=ANON, Authorization="Bearer " + ANON)
    return json.load(r)[0]


def maior_mes(md, nomes):
    """Mes de competencia mais alto do arquivo.

    ATENCAO: a coluna vem como TEXTO. Comparar sem converter daria "9" > "12",
    e o robo pararia de reconhecer outubro em diante — falha silenciosa, no fim
    do ano, quando ninguem estaria olhando.
    """
    i = nomes.index("NumMesCompetencia")
    mx = None
    for g in range(md.num_row_groups):
        st = md.row_group(g).column(i).statistics
        if not (st and st.has_min_max):
            continue
        try:
            v = int(st.max)
        except (TypeError, ValueError):
            continue
        mx = v if mx is None or v > mx else mx
    return mx


def main():
    if not (SEGREDO and ANON):
        sys.exit("faltam TEMPO_ANON_KEY ou TEMPO_INGESTAO_SEGREDO")

    est = estado_do_banco()
    print("banco: observado ate %s | previsao congelada de %s a %s | pares %s"
          % (est["observado_ate"], est["previsto_de"], est["previsto_ate"], est["pares_verificados"]))
    if not est["previsto_de"]:
        print("nada congelado ainda: nada a conferir."); return

    # mes que precisamos que o arquivo alcance
    falta_de = est["observado_ate"] or est["previsto_de"]
    ano_alvo, mes_alvo = int(falta_de[:4]), int(falta_de[5:7])

    pacote = json.load(buscar(CKAN))["result"]
    alvo = next((r for r in pacote["resources"]
                 if (r.get("format") or "").upper() == "PARQUET"
                 and str(ano_alvo) in (r.get("name") or "")), None)
    if alvo is None:
        sys.exit("nao achei o parquet de %d" % ano_alvo)

    tamanho = int(buscar(alvo["url"]).headers["Content-Length"])
    import pyarrow.parquet as pq
    f = ArquivoRemoto(alvo["url"], tamanho)
    pf = pq.ParquetFile(f)
    md = pf.metadata
    nomes = [md.schema.column(i).name for i in range(md.num_columns)]
    mes = maior_mes(md, nomes)
    print("parquet %s publicado em %s, cobre ate o mes %s (rodape: %.0f KB)"
          % (ano_alvo, alvo["last_modified"][:10], mes, f.baixado / 1024))
    if mes:
        registrar_arquivo(ano_alvo, mes, alvo.get("last_modified"))

    if mes is None or mes < mes_alvo:
        print("ainda nao alcanca o mes %d. Nada a ingerir — custou %.0f KB."
              % (mes_alvo, f.baixado / 1024))
        print("batimento:", enviar([]))
        return

    print("alcancou. Baixando as 2 colunas...")
    t0 = time.time()
    tab = pf.read(columns=["CodMunicipioIBGE", "DthIniOcorrencia"])

    import pandas as pd
    d = tab.to_pandas()
    d["ibge"] = pd.to_numeric(d.CodMunicipioIBGE, errors="coerce")
    d = d[(d.ibge >= 3300000) & (d.ibge < 3400000)]          # so o RJ
    d["dia"] = pd.to_datetime(d.DthIniOcorrencia, errors="coerce").dt.date
    d = d.dropna(subset=["ibge", "dia"])
    # Corte pelo que interessa: o servidor so aceita dia com previsao congelada,
    # mas mandar o ano inteiro seria megabytes de JSON a toa.
    de = pd.to_datetime(est["previsto_de"]).date()
    d = d[d.dia >= de]
    g = d.groupby(["ibge", "dia"]).size().reset_index(name="chamados")
    print("%s municipio-dia do RJ, de %s a %s (%.0f MB, %.0f s)"
          % (f"{len(g):,}", g.dia.min(), g.dia.max(), f.baixado / 1e6, time.time() - t0))

    if not len(g):
        print("nada no periodo com previsao congelada.")
        print("batimento:", enviar([]))
        return

    linhas = [{"ibge": int(r.ibge), "dia": str(r.dia), "chamados": int(r.chamados)}
              for r in g.itertuples()]
    LOTE = 5000          # um ano inteiro passa de 30 mil linhas; nao vai num JSON so
    for i in range(0, len(linhas), LOTE):
        print("lote %d: %s" % (i // LOTE + 1, enviar(linhas[i:i + LOTE])))


if __name__ == "__main__":
    main()
