# -*- coding: utf-8 -*-
"""D13 — PASSO 1: historico de trovoada da REDEMET (produto STSC) sobre o RJ.

Uso:  REDEMET_KEY=<chave> python 10_baixar_raio.py 2026-01-01 2026-07-31

A CHAVE NUNCA ENTRA NESTE ARQUIVO. Vem da variavel de ambiente REDEMET_KEY.
O arquivo vai para o GitHub, e segredo em historico de git nao se apaga (R9).

O QUE O STSC E
  "Ocorrencia de trovoada" (documentacao da API-REDEMET). Cada quadro e uma
  lista de celulas de uma grade de 0,05 grau (~5,5 km; o "raio": 5560 do
  retorno, em metros) com trovoada detectada. Quadros a cada 6-9 min, historico
  desde pelo menos 2022. A documentacao NAO diz que janela de tempo cada quadro
  cobre; medido em 07/11/2026, uma celula fica acesa ~30 min (mediana) e ate
  84 min (p90) — compativel com "trovoada nos ultimos ~30 min".

AMOSTRAGEM: UM QUADRO POR HORA
  O custo e de VOLUME, nao de chamadas: cada quadro traz o Brasil inteiro
  (~110 KB) e a API nao filtra por regiao. Um quadro por hora, com celula
  durando ~30 min, mede bem "em quantas horas do dia houve trovoada perto do
  municipio" — que e o que um driver diario precisa. 212 dias = 5.088 chamadas,
  ~560 MB trafegados, bem dentro dos limites (900/min, 10 mil/h, 100 mil/dia).

O QUE SE GUARDA
  So as celulas dentro do RJ com folga de ~30 km (os municipios de borda
  precisam ver trovoada do lado de la da divisa). Sai um parquet pequeno com
  (hora_utc, quadro, la, lo), mais o registro de cada hora pedida — inclusive
  as vazias, porque "nenhuma trovoada" tambem e dado. Retoma de onde parou.
"""
import os, sys, json, time, datetime as dt, concurrent.futures as cf
import urllib.request
import pandas as pd

CHAVE = os.environ.get("REDEMET_KEY")
if not CHAVE:
    sys.exit("defina REDEMET_KEY no ambiente")

URL = "https://api-redemet.decea.mil.br/produtos/stsc?data=%s"
LAT = (-23.6, -20.5)     # RJ: -23.37 a -20.76, com folga
LON = (-45.3, -40.6)     # RJ: -44.89 a -40.96, com folga
AQUI = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.join(AQUI, "raio_stsc.parquet")
CONTROLE = os.path.join(AQUI, "raio_stsc_horas.parquet")
TRABALHADORES = 6


def horas(ini, fim):
    # dia LOCAL (America/Sao_Paulo, UTC-3 fixo): 00h local = 03h UTC
    h = dt.datetime.fromisoformat(ini) + dt.timedelta(hours=3)
    ate = dt.datetime.fromisoformat(fim) + dt.timedelta(days=1, hours=3)
    while h < ate:
        yield h
        h += dt.timedelta(hours=1)


def buscar(h):
    chave_h = h.strftime("%Y%m%d%H")
    for tentativa in range(4):
        try:
            req = urllib.request.Request(URL % chave_h, headers={"X-Api-Key": CHAVE})
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.load(r)
            x = d.get("data") or {}
            quadros = x.get("stsc") or []
            rotulos = x.get("anima") or []
            pontos = []
            for rot, q in zip(rotulos, quadros):
                for p in q:
                    la, lo = float(p["la"]), float(p["lo"])
                    if LAT[0] <= la <= LAT[1] and LON[0] <= lo <= LON[1]:
                        pontos.append((h, rot, la, lo))
            total = sum(len(q) for q in quadros)
            return chave_h, True, total, (rotulos[-1] if rotulos else None), pontos
        except Exception as e:
            if tentativa == 3:
                return chave_h, False, 0, str(e)[:80], []
            time.sleep(5 * (tentativa + 1))


def main(ini, fim):
    feitas = set()
    if os.path.exists(CONTROLE):
        c = pd.read_parquet(CONTROLE)
        feitas = set(c.loc[c.ok, "hora"])
    pend = [h for h in horas(ini, fim) if h.strftime("%Y%m%d%H") not in feitas]
    print("horas pedidas: %d | ja feitas: %d | faltam: %d" % (len(feitas) + len(pend), len(feitas), len(pend)))

    ctl, pts = [], []
    t0 = time.time()
    with cf.ThreadPoolExecutor(TRABALHADORES) as ex:
        for i, (hk, ok, total, rot, p) in enumerate(ex.map(buscar, pend), 1):
            ctl.append({"hora": hk, "ok": ok, "pontos_brasil": total, "quadro": rot, "pontos_rj": len(p)})
            pts.extend(p)
            if i % 250 == 0 or i == len(pend):
                print("  %d/%d  %.0f s  falhas=%d" % (i, len(pend), time.time() - t0, sum(not c["ok"] for c in ctl)))
                salvar(ctl, pts)
                ctl, pts = [], []


def salvar(ctl, pts):
    novo_ctl = pd.DataFrame(ctl)
    if os.path.exists(CONTROLE):
        novo_ctl = pd.concat([pd.read_parquet(CONTROLE), novo_ctl]).drop_duplicates("hora", keep="last")
    novo_ctl.to_parquet(CONTROLE, index=False)
    if pts:
        novo = pd.DataFrame(pts, columns=["hora_utc", "quadro", "la", "lo"])
        if os.path.exists(SAIDA):
            novo = pd.concat([pd.read_parquet(SAIDA), novo]).drop_duplicates()
        novo.to_parquet(SAIDA, index=False)


if __name__ == "__main__":
    main(*(sys.argv[1:3] if len(sys.argv) >= 3 else ("2026-01-01", "2026-07-31")))
