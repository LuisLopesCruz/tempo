#!/bin/bash
# ============================================================================
# PASSO 1 — baixar os insumos da calibracao da camada 3
# ----------------------------------------------------------------------------
# Uso:  bash 1_baixar.sh 2025 [2026 2024 ...]
#
# Baixa, para cada ano pedido:
#   - ocorrencias da ANEEL (parquet, ~190-400 MB/ano)
#   - ERA5 diario + horario dos 92 municipios (Open-Meteo archive)
#
# CUIDADO COM A COTA DA OPEN-METEO. O limite e por MINUTO e por HORA, e pesa
# por volume: uma chamada de 30 anos x 8 pontos consome quase o minuto inteiro.
# Por isso ha espera de 40s entre lotes e retomada (lote ja baixado e pulado).
# Se aparecer "Hourly API request limit exceeded", nao adianta insistir:
# espere a proxima hora e rode de novo — ele continua de onde parou.
# ============================================================================
set -u
cd "$(dirname "$0")"
ANOS="${@:-2025}"

# resource ids do CKAN da ANEEL (dataset ced06b4c-45a5-4cae-8a7e-f576ffc3b412).
# Se algum ano faltar aqui, pegue em:
#   curl -s "https://dadosabertos.aneel.gov.br/api/3/action/package_show?id=ced06b4c-45a5-4cae-8a7e-f576ffc3b412" | grep -o '"id": "[^"]*"'
declare -A RES=(
  [2023]="560b6a3d-39b5-4b38-94ef-ca73d745866f"
  [2024]="ef1d1ae6-39f1-4d9c-ace8-3c5024ca777a"
  [2025]="6adda6b2-2e24-4637-8689-f48787847e8b"
  [2026]="d0669ad0-24a2-4f34-85cc-1b08e82d7ad2"
)
BASE="https://dadosabertos.aneel.gov.br/dataset/ced06b4c-45a5-4cae-8a7e-f576ffc3b412/resource"

for ANO in $ANOS; do
  f="oc${ANO}.parquet"
  if [ -s "$f" ]; then
    echo "ANEEL $ANO: ja baixado ($(du -h "$f" | cut -f1)), pulando"
  else
    echo "ANEEL $ANO: baixando..."
    curl -sL -m 1800 --retry 2 \
      "$BASE/${RES[$ANO]}/download/ocorrencias-emergenciais-rede-distribuicao-${ANO}.parquet" \
      -o "$f" -w "  HTTP%{http_code} %{size_download} bytes em %{time_total}s\n"
  fi
done

# --- coordenadas dos 92 pontos -------------------------------------------
# Gere uma vez com esta consulta e salve em ibges.txt / lats.txt / lons.txt:
#   select string_agg(municipio_ibge::text, ',' order by id),
#          string_agg(round(lat,4)::text,   ',' order by id),
#          string_agg(round(lon,4)::text,   ',' order by id)
#     from tempo.ponto where ativo;
for x in ibges lats lons; do
  [ -s "$x.txt" ] || { echo "FALTA $x.txt — veja o comentario acima"; exit 1; }
done

IFS=',' read -ra A <<< "$(tr -d '\r\n' < ibges.txt)"
IFS=',' read -ra B <<< "$(tr -d '\r\n' < lats.txt)"
IFS=',' read -ra C <<< "$(tr -d '\r\n' < lons.txt)"

# ERA5 tem defasagem de ~5 dias. Pedir ate 31/12 de um ano em curso devolve
# erro ou serie de nulos, entao a data final e limitada ao que ja existe.
LIMITE=$(date -u -d '-6 days' +%Y-%m-%d)

for ANO in $ANOS; do
  FIM="${ANO}-12-31"
  [[ "$FIM" > "$LIMITE" ]] && FIM="$LIMITE"
  echo "ERA5 $ANO: janela ${ANO}-01-01 a $FIM"
  N=${#A[@]}; K=6; i=0; lote=0
  while [ $i -lt $N ]; do
    out="era_${ANO}_${lote}.json"
    if [ -s "$out" ] && [ "$(wc -c < "$out")" -gt 100000 ]; then
      echo "ERA5 $ANO lote $lote: ja baixado"
    else
      baixou=1   # so lote baixado de verdade espera pela cota
      la=""; lo=""; ib=""
      for ((j=i; j<i+K && j<N; j++)); do la="$la,${B[$j]}"; lo="$lo,${C[$j]}"; ib="$ib,${A[$j]}"; done
      echo "${ib:1}" > "era_${ANO}_${lote}.ibge"
      for t in 1 2 3 4 5; do
        code=$(curl -s -m 300 -o "$out" -w "%{http_code}" \
          "https://archive-api.open-meteo.com/v1/archive?latitude=${la:1}&longitude=${lo:1}&start_date=${ANO}-01-01&end_date=${FIM}&daily=precipitation_sum,wind_gusts_10m_max&hourly=precipitation&timezone=America%2FSao_Paulo")
        [ "$code" = "200" ] && { echo "ERA5 $ANO lote $lote: OK"; break; }
        echo "ERA5 $ANO lote $lote: HTTP$code — esperando 70s (tentativa $t)"; sleep 70
      done
    fi
    [ "${baixou:-0}" = 1 ] && sleep 40; baixou=0; i=$((i+K)); lote=$((lote+1))
  done
done
echo "FIM. Proximo passo: python 2_montar_painel.py $ANOS"
