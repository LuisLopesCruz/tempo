# Recalibração da camada 3

Os coeficientes de impacto elétrico são uma **fotografia**. Nada no sistema os
atualiza sozinho — os 11 jobs do `pg_cron` cuidam de previsão, observação,
verificação e skill, mas não tocam na camada 3.

Este diretório existe para que a recalibração seja um procedimento de 20
minutos, e não uma redescoberta.

## Quando rodar

O job **`tempo_vigia_disparar` / `tempo_vigia_coletar`** roda toda **quarta às
06:00** e consulta o CKAN da ANEEL sem baixar nada (o `last_modified` e o
`size` vêm nos metadados). Para ver se há trabalho pendente:

```sql
select rotulo, last_modified, round(bytes/1048576.0) as mb, mudou_em, calibrado_em
  from tempo.fonte_externa
 where fonte = 'aneel_ocorrencias'
   and mudou_em is not null
   and (calibrado_em is null or mudou_em > calibrado_em)
 order by rotulo desc;
```

Linha aqui = há dado novo que a calibração ainda não viu.

## Como rodar

```bash
cd C:\TEMPO\calibracao
bash 1_baixar.sh 2025 2026          # ANEEL + ERA5. Demora; ver nota de cota.
python 2_montar_painel.py 2025 2026 # painel.parquet
python 3_ajustar_v4.py              # imprime diagnóstico e escreve v4.sql
```

Depois aplique `v4.sql` como migration e recarregue o painel.

Precisa de `pandas` e `pyarrow` (`python -m pip install pyarrow`).

## O que conferir antes de aplicar

O passo 3 imprime tudo isto. Se algum item destoar, **não aplique** — investigue.

| Item | Referência (4 anos, 2026-09-11) |
|---|---|
| `b` monotônico nas duas tabelas | faixa maior ⇒ `b` maior |
| viés | −0,23 |
| MAE | 9,03 (só base: 9,34) |
| municípios que atingem o próprio p95 | 28 de 92 |
| teto médio | 85% do p95 |
| curva de probabilidade | monotônica, terminando em ~32,5% |
| município-dia | 123.648 |
| dias na faixa ≥70 km/h | 177 |

## Duas armadilhas que já custaram tempo

**O schema da ANEEL muda entre anos.** Até 2025: `CodIBGE` (inteiro),
`DthInicioOcorrenciaAberta`, 15 colunas. De 2026: `CodMunicipioIBGE`,
`DthIniOcorrencia`, 23 colunas, tudo texto. O passo 2 já detecta — mas se um ano
novo quebrar com `No match for FieldRef.Name(...)`, é isto.

**O nível muda entre anos.** Em dia calmo, 2023 está em 77% de 2025. Por isso a
base é por **(município, ano)**: sem isso a tendência anual entra no modelo
disfarçada de efeito do tempo. O nível de produção sai do ano **completo** mais
recente; os coeficientes, de todos.

## Decisões embutidas, e por quê

**Alvo é chamado, não interrupção distinta.** O id de interrupção só é
registrado em 27% dos chamados da Light e 77% dos da Ampla. Usar interrupção
subcontaria a área da Light, que é a capital. É prática de registro, não física.

**O rótulo de causa não dimensiona nada.** A distribuidora classifica errado:
numa tempestade, muita queda de árvore entra como falha de equipamento.
Dimensionar pelo rótulo foi o erro da v3 — produzia um piso artificial de 7,8%
e o modelo nunca alcançava os dias ruins (só 1 município em 92 chegava ao
próprio p95). Os coeficientes vêm do excedente observado do **total**.

**Vento e raio somam, nunca multiplicam.** São mecanismos distintos, cada um
medido contra o seu próprio driver, numa regressão conjunta que separa as
contribuições sem dupla contagem.

**Fuso fixado em `America/Sao_Paulo`.** A data da ocorrência é local; o ERA5 em
UTC desalinharia 3 h e contaminaria justamente os eventos noturnos.

## Cota da Open-Meteo

O limite é por **minuto** e por **hora**, e pesa por volume. Uma chamada longa
com muitos pontos consome quase o minuto inteiro. O script espera 40 s entre
lotes e **retoma** — lote já baixado é pulado.

Se aparecer `Hourly API request limit exceeded`, não insista: espere a próxima
hora e rode de novo. Ele continua de onde parou.

## Verificação do impacto (passo 4)

Desde 2026-09-11 a camada 3 é verificável. O que estava quebrado não era a
defasagem da ANEEL — era a **amnésia**: `risco_energia` é uma view calculada na
hora, e nada guardava o que o painel tinha previsto.

`tempo.impacto_snapshot()` roda todo dia às 10:00 e congela a previsão de cada
município para os 6 dias à frente, num vetor por antecedência. Quando o lote da
ANEEL chega:

```bash
bash 1_baixar.sh 2026                    # só o parquet, se já apagou
python 4_carregar_observado.py 2026      # gera observado.sql
```

Aplique `observado.sql`: ele carrega as contagens reais **só para dias que já
tinham previsão congelada** e roda `tempo.impacto_pontuar()`, que produz Brier e
confiabilidade por antecedência em `tempo.impacto_skill` e
`tempo.impacto_confiabilidade`.

**Calibrar e verificar são coisas diferentes.** Calibrar ajusta o modelo ao
passado; verificar confere se a previsão que foi ao ar acertou. Usar o mesmo
dado para as duas seria medir o modelo com a própria régua — por isso o passo 4
só aceita dias que tinham previsão gravada *antes* do dado chegar.

O `limiar_dia_ruim` vive em `tempo.impacto_param` (hoje 2,19) e tem de casar com
a calibração que gerou `impacto_prob_v4`. Está fora do código justamente para
permitir reescore sem recarregar nada.

### O que ainda não é resolvível

A verificação é **retrospectiva, não corrente**: sempre chega semanas depois.
Isso é limite da fonte, não do desenho. Uma fonte de ocorrências em tempo real
resolveria — hoje não existe de graça.
