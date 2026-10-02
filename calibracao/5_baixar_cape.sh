#!/bin/bash
# ============================================================================
# CAPE historico — para testar se ele bate a intensidade de chuva como driver
# de descarga atmosferica (D11).
#
# NAO vem do ERA5: o arquivo de reanalise devolve a chave de CAPE com TODOS os
# valores nulos (testado). Vem do historical-forecast-api, que arquiva o que os
# modelos PREVIRAM. Isso e uma virtude e nao um defeito: em producao o sistema
# consome previsao, entao calibrar contra previsao arquivada mede o driver na
# mesma regua em que ele sera usado.
#
# Uso: bash 5_baixar_cape.sh 2023 2024 2025 2026
# Mesma cota da Open-Meteo: espera 40s, tenta de novo no 429, retoma.
# ============================================================================
set -u
cd "$(dirname "$0")"
ANOS="${@:-2025}"
IFS=',' read -ra A <<< "$(tr -d '\r\n' < ibges.txt)"
IFS=',' read -ra B <<< "$(tr -d '\r\n' < lats.txt)"
IFS=',' read -ra C <<< "$(tr -d '\r\n' < lons.txt)"
LIMITE=$(date -u -d '-6 days' +%Y-%m-%d)

for ANO in $ANOS; do
  FIM="${ANO}-12-31"; [[ "$FIM" > "$LIMITE" ]] && FIM="$LIMITE"
  N=${#A[@]}; K=6; i=0; lote=0
  while [ $i -lt $N ]; do
    out="cape_${ANO}_${lote}.json"
    if [ -s "$out" ] && [ "$(wc -c < "$out")" -gt 50000 ]; then
      echo "CAPE $ANO lote $lote: ja baixado"
    else
      la=""; lo=""; ib=""
      for ((j=i; j<i+K && j<N; j++)); do la="$la,${B[$j]}"; lo="$lo,${C[$j]}"; ib="$ib,${A[$j]}"; done
      echo "${ib:1}" > "cape_${ANO}_${lote}.ibge"
      for t in 1 2 3 4 5; do
        code=$(curl -s -m 300 -o "$out" -w "%{http_code}" \
          "https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${la:1}&longitude=${lo:1}&start_date=${ANO}-01-01&end_date=${FIM}&hourly=cape&timezone=America%2FSao_Paulo")
        [ "$code" = "200" ] && { echo "CAPE $ANO lote $lote: OK $(wc -c < "$out")B"; break; }
        echo "CAPE $ANO lote $lote: HTTP$code — esperando 70s (tentativa $t)"; sleep 70
      done
    fi
    sleep 40; i=$((i+K)); lote=$((lote+1))
  done
done
echo "FIM"
