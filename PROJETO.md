# TEMPO-RJ — Sistema de Previsão Consolidada e Risco de Impacto

> Documento de referência conceitual e arquitetural.
> Criado em 2026-09-10. Última atualização: **2026-09-28** — pesos por skill
> em vigor (§9.7), painel com busca, cartão de condição e monitor (§12.2),
> riscos R1/R4/R5/R7 encerrados e R13 aberto (§13), calibração medida e
> mostrada (§9.8).
> **Este documento precede o código.** Toda decisão de implementação deve ser
> rastreável até aqui — e, quando contrariá-lo, o documento é atualizado antes.

---

## 1. O que é

Sistema que agrega o maior número possível de fontes de previsão meteorológica,
cruza com alertas de órgãos governamentais brasileiros, e produz uma previsão
consolidada com **probabilidade calibrada** — estendendo-a até a previsão de
**impacto**, com foco em interrupção de energia elétrica.

Não é um agregador de previsões. É um sistema de **fusão, calibração e
verificação** que aprende com os próprios erros.

---

## 2. Premissas invioláveis

Definidas pelo usuário. Qualquer proposta que as viole deve ser rejeitada ou
renegociada explicitamente.

| # | Premissa | Consequência arquitetural |
|---|---|---|
| **P1** | **Custo R$ 0,00** — total e permanente | Só free tiers. O orçamento de armazenamento vira o constraint mestre. |
| **P2** | Uso pessoal — o autor e, talvez, 1–2 amigos | Sem multi-tenancy, sem escala. Mas RLS é obrigatória mesmo assim. |
| **P3** | **HTML standalone** consumindo dados do **Supabase** | O front não tem lógica de coleta. É consumidor puro. |
| **P4** | **Nada armazenado em máquina local** — roda em qualquer máquina | Não pode haver processo local, cron local ou banco local. |

### Consequência combinada de P3 + P4

Um HTML só executa quando alguém o abre. Logo, ele **não pode ser o coletor** —
haveria buracos no histórico e a camada de verificação seria impossível.

> **O Supabase não é o banco do projeto. O Supabase *é* o projeto.**

Ele fornece, no plano gratuito, o backend completo: `pg_cron` agenda,
Edge Functions coletam e fazem proxy, Postgres normaliza e funde, PostgREST +
RLS servem ao HTML.

---

## 3. Escopo

| Dimensão | Definição |
|---|---|
| **Geográfico** | Estado do Rio de Janeiro (92 municípios) — por ora |
| **Unidade de cálculo** | ~120 pontos representativos (ver §6) |
| **Unidade de comunicação** | Município |
| **Horizonte** | Nowcasting (0–6 h) até 5 dias |
| **Usuários** | 1 a 3 pessoas |

---

## 4. Modelo conceitual — as três camadas

O erro clássico do domínio é confundir estas camadas. Elas são distintas e
empilhadas:

| Camada | Pergunta | Natureza |
|---|---|---|
| **1 — Física** | O que a atmosfera vai fazer? | Modelos numéricos, ensemble |
| **2 — Perigo (*hazard*)** | O que isso causa no terreno? | Solo, saturação, topografia, bacia |
| **3 — Impacto** | O que quebra? | Infraestrutura, exposição, vulnerabilidade |

**80 mm de chuva não é um alerta.** 80 mm sobre solo já saturado, em encosta
ocupada, com rede aérea de distribuição e vento de 60 km/h — isso é um alerta.
A mesma chuva em outro lugar é irrelevante.

O diferencial do projeto vive na camada 3. Mas ela só é honesta se 1 e 2 forem.

---

## 5. Princípios de design

Os cinco princípios abaixo são o núcleo intelectual do projeto.

### 5.1 O voto é por linhagem, não por fonte

Doze apps de previsão não são doze opiniões. Cinco rodam **GFS**, três rodam
**ECMWF/IFS**, dois rodam **ICON**, dois têm modelo próprio — são **quatro**
opiniões. "Maioria das fontes" mede popularidade comercial, não acerto.

**Regra:** toda previsão ingerida carrega sua **linhagem de modelo**. A fusão
agrupa por linhagem antes de ponderar. Fontes derivadas nunca votam duas vezes.

### 5.2 O peso vem de skill medido, não de opinião

Nenhum modelo é melhor em tudo. ECMWF tende a dominar em médio prazo global;
modelos de mesoescala regionais tendem a ganhar em convecção local de curto
prazo. Isso não se decide — **se mede**, por região, variável e horizonte.

### 5.3 Órgãos oficiais não são votantes no ensemble

Eles têm naturezas epistemologicamente distintas entre si:

| Órgão | Natureza | Papel no sistema |
|---|---|---|
| **INMET** | Aviso meteorológico (previsão + limiar) | Previsão com autoridade |
| **CEMADEN** | Monitoramento hidrológico/geológico | **Observação** — estado presente |
| **Alerta Rio** | Radar + pluviômetros (capital) | **Observação** de alta densidade |
| **Defesa Civil** | Decisão e ação humana | **Autoridade normativa** |
| **ANEEL / distribuidoras** | Interrupção ocorrida | **Consequência** |

> Observação **corrige** a previsão.
> Alerta oficial **sobrepõe** a previsão — não vota nela.
> Consequência **treina** o modelo de impacto.

### 5.4 Probabilidade sem calibração é mentira educada

Se o sistema diz "70%", precisa ter chovido em ~70% das vezes em que ele disse
70%. Isso exige guardar toda previsão emitida e verificá-la depois
(Brier score, curva de confiabilidade).

**Consequência de modelagem:** o banco é *append-only* e temporal desde o
primeiro dia. Toda previsão nasce com `emitida_em`, `valida_para`, `fonte`,
`linhagem`. **Nunca sobrescrever.**

### 5.5 Discordância é informação, não ruído

Quando as fontes divergem, a resposta certa **não** é tirar a média e exibir um
número confiante. A dispersão do ensemble *é* a medida de incerteza — muitas
vezes o dado mais útil que o sistema tem.

O sistema deve poder dizer: *"alta confiança de chuva, baixa confiança de
volume"* — ou simplesmente *"os modelos não concordam"*.

**Regra de apresentação:** a probabilidade nunca aparece sozinha. Sempre
acompanhada de (a) dispersão e (b) número de linhagens independentes que
concordam.

---

### 5.6 Uma dimensão por canal visual

Aprendido na marra em 2026-09-11. A barra de risco elétrico pintava o segmento
de vento pela **gravidade do dia** e o de raio pela **causa** — duas dimensões
disputando o mesmo canal de cor. Em dia normal o vento ficava azul; o raio
também era azul; e o leitor via uma barra azul sem saber qual das duas coisas
estava olhando. Nenhuma legenda conserta isso: ela teria que dizer "azul é
vento, exceto quando é raio".

A regra: **cor codifica causa, palavra codifica gravidade, comprimento codifica
magnitude.** Um canal, um significado. E quando o canal escolhido é cor, vale
duplicar com algo que não dependa dela — a hachura no segmento de raio existe
porque azul e violeta são justamente o par que colapsa em daltonismo
vermelho-verde.

Corolário que vale para todo gráfico do painel: **escala relativa precisa ser
declarada.** As barras de risco são proporcionais ao pior dia da janela de
cinco, não a um teto fixo. Sem dizer isso, barra cheia é lida como "risco
máximo" quando significa apenas "o maior destes cinco".

### 5.7 Todo número visível diz de que ele é

Aprendido por correção do usuário **três vezes seguidas** em 2026-09-11, o que
o torna princípio e não descuido. Um número grande e sozinho no cartão — `34%`,
`24%`, `35%` — é ilegível mesmo quando o título do cartão explica: o olho pousa
no número, não no cabeçalho, e o cabeçalho fica fora do campo de leitura quando
o cartão é largo.

A regra: **a unidade ou a definição viaja junto do número, no ponto em que ele
aparece**, ainda que em fonte menor e ainda que repita o título. "24% de chance
de ser um dia ruim" no próprio cartão, não "24%" sob um cabeçalho que diz risco.

### 5.8 Ausência precisa ter desenho próprio

Dois erros do mesmo tipo, encontrados em 2026-09-15.

**(a) O zero que mentia.** A barra do cartão principal conta quantas das 8
famílias preveem chuva, mas a legenda dizia "concordam". Nos valores altos as
duas coisas coincidem por acaso; na ponta de baixo a frase inverte — em dia de
sol firme as oito famílias estão em pleno acordo e o painel anunciava
**"0 de 8 concordam"**, isto é, caos total na previsão mais confiável que
existe. Corrigido: a linha declara os dois lados ("3 de 8 preveem chuva · 5
não") e a palavra *concordam* fica reservada ao voto unânime.

**(b) O preto que parecia defeito.** O mapa de chuva hora a hora deixa o dia bom
inteiramente escuro. Escuro é indistinguível de "a coleta falhou" — observação
do usuário, e ele tinha razão. A solução não foi pintar o mapa de chuva de outro
jeito: foi **acrescentar um cartão que responde a outra pergunta** (como o céu
deve estar), no qual toda hora tem desenho. Ver §12.2.

O princípio geral: **quando o dado diz "nada acontece", isso tem de ter forma
visível própria**, distinta de erro e distinta de vazio. E quando não se sabe —
como nas horas sem cobertura de nuvem coletada — a célula fica vazia com
explicação, nunca preenchida com um chute plausível.

---

## 6. O constraint mestre: 500 MB

O plano gratuito do Supabase oferece ~500 MB de banco. Isso define a arquitetura
mais do que qualquer preferência técnica.

### Por que o grid regular foi descartado

Grid de 0,1° sobre o RJ (~600 pontos em terra), previsão horária a 5 dias
(120 h), 4 linhagens, 4 rodadas/dia:

```
600 × 120 × 4          = 288.000 registros por rodada
× 4 rodadas/dia        = 1,15 milhão de registros/dia
× ~100 bytes           ≈ 115 MB/dia   →  banco cheio em 4 dias
```

### O desenho adotado

| Decisão | Valor |
|---|---|
| Pontos de cálculo | **~120** — 92 sedes municipais + pontos extras em municípios grandes e de risco (Petrópolis, Teresópolis, Nova Friburgo, Angra, Campos, capital) |
| Unidade de linha | **1 linha JSONB por (ponto, rodada, linhagem)** — a série de 120 h vira um blob comprimido |
| Volume resultante | `120 × 4 × 4 ≈ 1.900 linhas/dia` |

### Política de esquecimento

Decisão de projeto de primeira classe, não detalhe operacional:

| Dado | Retenção | Justificativa |
|---|---|---|
| Previsão bruta detalhada | 7–10 dias | Só serve até ser verificada |
| Observação (chuva, vento, raios) | 90+ dias | É barata e é a verdade |
| Alertas oficiais | Permanente | Baixo volume; histórico do que "quase aconteceu" |
| **Score de acerto por modelo/região/variável** | **Permanente** | É o destilado — o que o sistema aprendeu |

> **O sistema não precisa lembrar das previsões. Precisa lembrar do que aprendeu
> com elas.** Os 500 MB forçam essa disciplina — e ela melhora o projeto.

---

## 7. Arquitetura

```
┌─ SUPABASE (roda sozinho, 24/7, R$ 0) ──────────────────────┐
│                                                             │
│  pg_cron ──► Edge Function ──► [fontes externas]            │
│                    │           (também atua como proxy      │
│                    │            para fontes sem CORS)       │
│                    ▼                                        │
│         [1] normalização + LINHAGEM                         │
│                    ▼                                        │
│         [2] fusão ponderada por skill (SQL / views)         │
│                    ▼                                        │
│         [3] camada hazard  (+ CEMADEN, solo, acumulado)     │
│                    ▼                                        │
│         [4] camada impacto (+ histórico ANEEL, rede)        │
│                    ▼                                        │
│         [5] verificação ──┐                                 │
│                    │      │ realimenta os pesos de [2] e [4]│
│                    │      └─────────────────────────────────│
│                    ▼                                        │
│              PostgREST + RLS                                │
└────────────────────│────────────────────────────────────────┘
                     ▼
        HTML standalone hospedado (somente leitura)
                     │
                     └──► botão "faltou luz aqui" (escrita restrita)
```

O bloco **[5] verificação** é o que separa este projeto de um *mashup* de APIs.

---

## 8. Fontes de dados

### 8.1 Camada 1 — modelos numéricos (espinha dorsal)

**Open-Meteo** resolve o problema da linhagem de forma quase perfeita: gratuito
para uso não comercial, sem chave, com CORS, e **entrega cada modelo
separadamente** — GFS, ICON, ECMWF/IFS, GEM, ARPEGE, JMA, MET Norway. Não é
preciso adivinhar a procedência: pede-se por nome.

- **Ensemble API** → entrega os membros (GEFS, ICON-EPS). *A dispersão vem de graça.*
- **API histórica (ERA5)** → meteorologia horária retroativa. **Fundamental** — ver §9.

### 8.2 Camada 2 — observação e alerta

| Fonte | O que traz | Cobertura |
|---|---|---|
| **Alerta Rio** | Radar meteorológico + rede densa de pluviômetros | Capital — ativo excepcional |
| **CEMADEN** | Pluviômetros automáticos + risco geológico/hidrológico | Boa densidade na Região Serrana |
| **INMET** | Estações automáticas + avisos por município | Estadual |
| **INEA** | Monitoramento hidrológico estadual | Estadual |
| **REDEMET** | METAR dos aeroportos (SBGL, SBRJ, SBJR, Campos, Resende) | Pontual, qualidade aeronáutica |
| **Defesa Civil** (estadual/municipal) | Decisão e ação | Estadual |
| **CPTEC/INPE** | Satélite GOES, descargas atmosféricas | Nacional |

> **Nota técnica:** várias fontes brasileiras não enviam cabeçalho CORS. O HTML
> não pode chamá-las direto — precisam passar pela Edge Function. Isso reforça
> a arquitetura: a Edge Function é agendador **e** proxy.

#### ✅ Testado em 2026-09-10 — o que realmente funciona

> **A descoberta que destravou tudo: User-Agent.** Sem cabeçalho de navegador,
> o Alerta Rio devolve `Request Rejected` (WAF) e o INMET **derruba a conexão**
> (`Recv failure: Connection was reset`). Com um UA de Chrome, ambos respondem
> 200. Isso não é detalhe cosmético — é pré-requisito, e está comentado no
> código para não se perder.

| Fonte | Endpoint | Resultado |
|---|---|---|
| **Alerta Rio** | `websempre.rio.rj.gov.br/json/chuvas` | ✅ **Em uso.** 33 pluviômetros, janelas m05/m15/h01/h02/h03/h04/h24/h96/mês, com lat/lon e `read_at`. |
| **INMET — avisos** | `apiprevmet3.inmet.gov.br/avisos/ativos` | ✅ **Em uso.** ~618 KB nacional, chaves `hoje`/`futuro`, `geocodes` IBGE, severidade e **texto de `riscos`** que cita corte de energia. |
| **INMET — estações** | `apitempo.inmet.gov.br/estacoes/T` | ⚠️ Lista funciona (26 estações operantes no RJ, com coordenadas)… |
| **INMET — dados de estação** | `apitempo.inmet.gov.br/estacao/{ini}/{fim}/{cod}` | ❌ **204 sem conteúdo** em toda data testada (2024 a 2026). A rota existe (204, não 404) mas as vizinhas dão 404 e `/token/estacao/.../{token}` responde 200 — **o INMET fechou os dados atrás de token**. Não utilizável sem solicitar credencial. |
| **CEMADEN** | `resources.cemaden.gov.br/graficos/interativo/getJson2.php?uf=RJ` | ✅ **Em uso desde 2026-09-11.** 118 KB, JSON plano, **395 estações no RJ / ~204 vivas / 64 municípios**. Campos `codibge`, `datahoraUltimovalor` e acumulados `acc1hr`…`acc96hr`. Também exige User-Agent de navegador. |

**Cobertura da observação (2026-09-11).** Com o CEMADEN, a observação deixou de
ser só a capital: **64 dos 92 municípios**, nas 8 regiões do estado. A Serrana é a
melhor coberta — Nova Friburgo 28 estações, Petrópolis 25, Teresópolis 22 —, o que
faz sentido, já que o CEMADEN nasceu do desastre de 2011 ali.

Faltam 28 municípios, concentrados no **Noroeste** (8) e nas **Baixadas** (7);
também Macaé, Cabo Frio e Carmo. **Eles não ficam sem peso:** a skill é calculada
**por região** e aplicada a todos os municípios da região, então os 28 recebem o peso
medido nos vizinhos (verificado em 2026-10-15: 0 dos 92 sem peso). O que falta neles é
**verificação local** — o acerto no próprio município não é medido. Vários têm estação
do INMET, **mas o token foi negado em 2026-10-04** (ver decisões), então esse buraco
não fecha por esse caminho.

> Correção: até 2026-10-15 este parágrafo dizia que os 28 "seguem com pesos neutros".
> Estava errado — a frase foi escrita sem conferir o `tempo.consolidado`, que junta a
> skill por `regiao`, não por município.

#### Duas ambiguidades do CEMADEN resolvidas no dado, não no chute

1. **`"-"` é como o CEMADEN escreve zero.** Zero nunca aparece como número em 395
   registros × 5 janelas; e tratar `"-"` como 0 deixa **203/203** estações com série
   monotônica (`1h ≤ 3h ≤ 6h ≤ 12h ≤ 24h`). Se fosse dado ausente, haveria violações.
   Vale só para estação viva — estação morta é descartada, não zerada.
2. **`datahoraUltimovalor` está em UTC.** O atraso das leituras em relação ao download
   agrupa em 0–50 min (p05 = −0,6). Se fosse horário de Brasília, agruparia em +180 min.
   Há deriva de relógio nos dois sentidos, daí a janela de aceitação de ±90 min.

#### Formato: vetor de 24 horas, não uma linha por leitura

`tempo.observacao_dia` guarda **uma linha por (município, dia)** com vetores de 24
posições (média, mediana, máxima entre estações e nº de estações por hora). Em formato
longo, os 120 dias de retenção custariam **~125 MB**; assim custam **~3 MB**. É o mesmo
princípio que já rege `tempo.previsao`.

Guardar média *e* mediana é deliberado: a média estima melhor a chuva areal quando há
20 estações, a mediana é mais robusta quando há 2. Observação não se recoleta depois.

#### Coletado pelo Postgres, sem Edge Function

É um `GET` só, de JSON plano — `pg_net` dá conta. `tempo.cemaden_disparar()` às :08,
`tempo.cemaden_coletar()` às :12, antes da verificação das :25. Efeito colateral útil:
não dependeu do `deploy_edge_function`, que estava quebrado na sessão.

### 8.3 Camada 3 — impacto elétrico (ANEEL)

São **dois sistemas distintos**, de naturezas opostas.

#### (a) ANEEL RADAR — tempo real

Sistema nacional que mostra em tempo real **quantos clientes estão sem energia**
por região. Anunciado em ago/2025; adesão obrigatória das distribuidoras até
jan/2026; lançamento público previsto para o 1º tri/2026.

Indicadores expostos: nº de clientes sem energia por região, localização,
frequência, duração, **previsão de restabelecimento** (obrigatória em até 15 min
após a interrupção) e desempenho da concessionária no tempo.

#### VERIFICADO EM 2026-09-10 — o painel EXISTE, mas não é ingerível

⚠️ **Correção de um erro meu.** Na primeira verificação concluí que o painel
"não estava publicado". **Estava errado.** Eu havia percorrido apenas a *lista*
de workspaces do `portalrelatorios.aneel.gov.br` e parei ali — sem abrir o
conteúdo de cada um. O painel está dentro do workspace **"Hub da Distribuição
SMA"** (17 conteúdos), que eu vi listado e não explorei.

**URL real** (indicada pelo usuário):
`portalrelatorios.aneel.gov.br/hubDistribuicao/monitoramentoInterrupcoesFornecimentoBrasil`
— *"Monitoramento das Interrupções do Fornecimento no Brasil — acompanhe as
interrupções do fornecimento de energia em tempo real."*

**Mas a conclusão prática se mantém:** o painel é um `iframe` de
`app.powerbi.com/reportEmbed` (`reportId=ddf8856b-5fb9-43d8-b2e6-506e1a9fd9d1`).
Não há API JSON pública. Consumi-lo automaticamente exigiria bater no endpoint
interno de query do Power BI — instável, sem contrato e fora dos termos de uso.

**Decisão:** o painel entra como **referência de consulta manual**, linkado no
rodapé do front. Não é fonte de ingestão. Se um dia a ANEEL publicar API aberta
(o RADAR prometia isso), reavaliar.

**Lição de método registrada:** verificação por listagem de catálogo não é
verificação. Abrir o índice não é abrir o conteúdo.

#### (b) Dados abertos históricos — o achado mais valioso

Dataset [*Interrupções de Energia Elétrica nas Redes de Distribuição*](https://dadosabertos.aneel.gov.br/dataset/interrupcoes-de-energia-eletrica-nas-redes-de-distribuicao):

| Característica | Valor |
|---|---|
| Cobertura temporal | **2017 – 2026** |
| Granularidade | **Por evento**, timestamp em hora:minuto:segundo |
| Granularidade geográfica | Conjunto de unidades consumidoras (mais fino que município) |
| Atualização | **Mensal** |
| Formato | ZIP e Parquet, **~200–270 MB por ano** |
| Licença | ODbL (aberta) |
| ⚠️ API | **Não há datastore API.** Verificado via CKAN: nenhum recurso tem `datastore_active`. Só download integral. |
| ⚠️ Lacuna | Não cobre permissionárias/cooperativas (irrelevante para o RJ) |

**Detalhe de ouro — "Expurgos":** são as interrupções excluídas do cálculo de
DEC/FEC, tipicamente **eventos climáticos extremos**. A própria distribuidora já
rotulou, para nós, quais eventos foram catástrofes meteorológicas.
**É um dataset rotulado, de graça.**

#### (c) Três datasets adicionais descobertos em 2026-09-10

A descrição do workspace de Fiscalização revelou que existe uma família de dados
de **"ocorrências emergenciais"** — distinta de "interrupções" e mais próxima do
dano causado por tempestade. Consulta ao CKAN da ANEEL:

| Dataset | Cobertura | Tamanho | Avaliação |
|---|---|---|---|
| **Atendimento às Ocorrências Emergenciais** | **2009 →** (mensal, por conjunto) | **Parquet 18,1 MB** | ⭐ **O melhor custo-benefício.** 17 anos, cabe inteiro no orçamento. Tempos de preparo/deslocamento/execução e % de interrupções. |
| **Ocorrências Emergenciais nas Redes de Distribuição** | 2017–2026 (por ocorrência) | ~176–195 MB/ano | Granularidade máxima, mesmo problema de tamanho das interrupções. Requer destilação. |
| **Evento Situação de Emergência** | 2026 → | **CSV 70 KB + 11 KB** | ⭐ **Joia.** Decretos de calamidade pública e situação de emergência **por município**, com tipo de evento e vigência. Rótulo oficial de catástrofe, minúsculo. |

**Impacto no projeto:** o dataset de *Atendimento* (18 MB, desde 2009) e o de
*Situação de Emergência* (81 KB) são pequenos o bastante para entrar **direto**,
sem passar pela bancada de destilação. Isso antecipa a camada de impacto: dá
para começar a treinar antes mesmo de processar os Parquet gigantes.

**"Dia crítico"** é a definição *oficial* da ANEEL para um dia em que as
ocorrências emergenciais excedem o limiar estatístico — ou seja, a própria
agência já marcou quais dias foram eventos climáticos de massa. É o rótulo que
a camada 3 precisa, pronto e auditado.

---

## 9. A descoberta que mudou a arquitetura

Na concepção inicial, concluímos que a camada de impacto elétrico "nasceria
cega" — sem forma de saber se acertou. **Isso foi superado.**

```
8 anos de interrupções do RJ (ANEEL, por evento, por conjunto)
                        ×
8 anos de meteorologia horária (Open-Meteo / ERA5, por ponto)
                        ↓
              modelo empírico de impacto
```

A camada 3 deixa de ser heurística e vira **regressão sobre dado real**.
O botão "faltou luz" deixa de ser a única verdade e passa a ser **validação
contínua de um modelo já treinado**.

### Insights extraíveis do cruzamento

1. **Baseline por conjunto elétrico** — quantas interrupções são normais por mês. Sem isso, "muitas quedas" não significa nada.
2. **Sazonalidade** — assinatura verão/inverno do RJ (convecção × frentes frias).
3. **Limiares empíricos** — *"rajada acima de X km/h em Petrópolis multiplica interrupções por Y"*. É literalmente a função que a camada 3 precisa.
4. **Vulnerabilidade relativa por município** — quais trechos da rede quebram mais fácil sob a mesma tempestade. Não existe publicado de forma digerida.
5. **Tempo típico de restabelecimento** por causa e intensidade → prever *duração*, não só ocorrência.
6. **Curva de resposta** — a defasagem entre o pico de chuva/vento e a queda de energia. Ela existe e é previsível.
7. **Catálogo de eventos extremos** via expurgos — os piores dias do RJ em 8 anos, prontos para estudo.

## 9.0 ⚠️ REVISÃO CRÍTICA DA CAMADA 3 (2026-09-11)

> O usuário questionou a magnitude de "ocorrências/dia". A revisão mostrou que
> a v1 estava **metodologicamente errada**. Este bloco fica como registro do
> erro; §9.1 descreve o modelo corrigido.

### O que é uma "ocorrência" — verificado no dado

`DscCanalAtendimento` nas 1.018.800 ocorrências do RJ em 2025:

| Canal | Registros | % |
|---|---|---|
| RECLAMAÇÃO / Reclamação do Consumidor / Reclamação | 1.004.626 | **98,6 %** |
| Sistema de Supervisão | 13.572 | 1,3 % |
| Informação / Alarme | 602 | 0,1 % |

**Ocorrência é um chamado de cliente**, não um evento de rede e não um cliente
sem energia. Um desligamento gera vários chamados; um chamado pode representar
muitos clientes. `DscNumInterrupcao` confirma: até 4 ocorrências apontam para a
mesma interrupção, e **51 % nem têm interrupção associada** (`S/I`).

### Os três erros da v1

1. **Aplicou multiplicador climático ao baseline TOTAL.** Só **7,2 %** dos
   chamados têm causa meteorológica (árvore 45.562, animais 8.761, descarga
   7.869, vento 5.570, inundação, erosão…). Os outros 93 % são falha de
   equipamento — que o tempo não prediz.
2. **Rotulou o total como "acima do normal".** O número exibido era o total
   esperado, não o excedente. Erro de rótulo puro e simples.
3. **Não considerou dia da semana nem distribuidora**, ambos com efeito maior
   que várias faixas de vento.

### Backtest que reprovou a v1

Nos 20 piores dias do estado a v1 previa ~780 onde ocorreram **1.300–1.616**.
Esses dias tinham rajada de 32–49 km/h — não eram temporais.
Em 22/09/2025 houve 1.616 chamados no Rio e **apenas 49** de causa climática.

O maior pico de 2025 em Petrópolis (375 chamados, 06/05) foi **100 % da Ampla**,
concentrado entre 11 h e 15 h, com 248 classificados como *falha de material*
e apenas 7 como *árvore*. Rajada naquele dia: **20 km/h**.

### Efeitos que superam o clima

| Efeito | Magnitude |
|---|---|
| **Dia da semana** | seg/ter ~3.020 chamados → dom 1.876 (**−38 %**) |
| **Distribuidora** | Ampla tem 43,6 % do total mas **71 %** dos chamados em dias de pico |
| Rajada 40–50 km/h (v1) | +27 % |

---

## 9.1 ✅ MODELO v2 — o alvo correto

O que §9 prometia como possibilidade agora está medido e em produção.

**Insumos processados** (em ambiente efêmero, destruído ao final — 629 MB
baixados, 447 KB preservados):

| Fonte | Volume |
|---|---|
| *Ocorrências Emergenciais nas Redes de Distribuição 2025* (ANEEL) | 398 MB, **11.584.917 ocorrências** no país |
| Filtrado ao RJ via `CodIBGE` | **1.018.800 ocorrências**, 92 municípios |
| *Atendimento às Ocorrências Emergenciais* (ANEEL) | 18 MB, 6,78 M linhas, **2000–2026** |
| ERA5 diário 2025 (Open-Meteo archive) | 33.580 dias-município |

O dataset por ocorrência traz **`CodIBGE`** — foi isso que resolveu o problema
de geografia que o indicador mensal (agregado por *conjunto elétrico*) não
resolvia.

## 9.2 ✅ MODELO v3 — ADITIVO POR CAUSA (2026-09-11)

> Correção proposta pelo usuário: *"os eventos se somam, cada um a sua medida,
> e não multiplicação da multiplicação"*. **Medida e confirmada.**

A v2 usava o **maior** dos multiplicadores. Isso subestima quando duas causas
atuam no mesmo dia. O produto, por outro lado, superestima — conta o mesmo
temporal duas vezes.

**Por que somar não duplica:** uma ocorrência pertence a **exatamente uma**
causa. Árvore caída não é descarga atmosférica. Os alvos são disjuntos.

### Cada causa responde ao seu próprio driver — medido, não suposto

| Causa | n (2025) | rajada | chuva dia | chuva máx/h |
|---|---|---|---|---|
| **vento** (árvore, vegetação, vento) | 51.132 | **+0,203** | +0,193 | +0,143 |
| **raio** (descarga atmosférica) | 8.323 | **+0,032** | +0,221 | **+0,207** |
| água (inundação, erosão) | 99 | +0,035 | +0,002 | −0,000 |

**Raio praticamente não responde a rajada (0,03).** São mecanismos distintos —
exatamente o que a soma separada reconhece e o "maior fator" ignorava.

*(Água tem 99 ocorrências: ruído. Fora do modelo.)*

### Validação contra 2025 — o aditivo vence

| Método | MAE do acréscimo | Viés |
|---|---|---|
| **Aditivo (v3)** | **1,430** | −0,43 |
| Maior fator (v2) | 1,764 | **+0,59** |

**19 % menos erro**, e o método antigo **superestimava** sistematicamente.

### Multiplicadores v3

**Vento ← rajada máxima diária**

| Faixa | Mult. | p90 | Dias |
|---|---|---|---|
| < 30 km/h | 1,00× | 3,05× | 12.631 |
| 30–40 | 1,28× | 3,62× | 12.557 |
| 40–50 | 1,60× | 4,24× | 6.263 |
| 50–60 | 2,37× | 5,79× | 1.650 |
| 60–70 | 3,93× | 8,33× | 411 |
| **≥ 70** | **6,86×** | 14,69× | 68 |

**Raio ← intensidade máxima horária de chuva**

| Faixa | Mult. | p90 | Dias |
|---|---|---|---|
| < 1 mm/h | 1,00× | — | 25.562 |
| 1–3 | 3,78× | 9,28× | 4.419 |
| 3–6 | 5,05× | 15,80× | 2.192 |
| 6–12 | 5,91× | 16,71× | 1.179 |
| **≥ 12** | **7,53×** | 18,81× | 228 |

Driver de raio escolhido **por erro medido** (MAE 1,4300 contra 1,4324 do
acumulado diário) e por faixas muito melhor povoadas: 228 dias na faixa
extrema contra 36.

### Fórmula

```
acréscimo = base_vento × (mult_vento − 1)  +  base_raio × (mult_raio − 1)
total     = base_total × fator_dia_semana  +  acréscimo
```

**Exemplo real — Rio, 10/09/2026:** vento +1,6 **e** raio +2,0 = **+3,6**.
O método do maior fator teria descartado metade da contribuição.

### Correção adicional de escopo

`ANIMAIS` (8.761), `CORROSAO` (149), `INCENDIO` (203) e `QUEIMA` (134) estavam
no alvo da v2 **apenas porque a categoria começa com "MEIO AMBIENTE"**.
Animal não é tempo. Removidos — o alvo caiu de 73.114 para **59.455**.

### Baselines zerados

18 municípios tinham `base_raio = 0` — amostra fina em dia calmo, não ausência
de raio. Receberam piso proporcional ao porte, pela razão estadual
(raio/total = 0,0039).

---

### A correção anterior (v2): alvo restrito à ocorrência de causa meteorológica

Isolando os 73.114 chamados de causa climática, o sinal que estava diluído em
93 % de ruído aparece:

| Correlação com | v1 (todas) | **v2 (climáticas)** |
|---|---|---|
| Rajada | 0,115 | **0,182** |
| Chuva | **0,005** | **0,208** |

A correlação com chuva era **praticamente zero** no alvo errado.

### Multiplicadores v2 — sobre a ocorrência climática, normalizado ao dia calmo

Calculados com **média**, não mediana: contagens são aditivas, e a mediana
colapsa em zero nos municípios pequenos.

| Rajada máx. | Multiplicador | p90 | Dias |
|---|---|---|---|
| < 30 km/h | 1,00× | 2,93× | 12.631 |
| 30–40 | 1,23× | 3,26× | 12.557 |
| 40–50 | 1,40× | 3,41× | 6.263 |
| 50–60 | 1,88× | 4,34× | 1.650 |
| 60–70 | 3,09× | 6,67× | 411 |
| **≥ 70** | **5,29×** | **11,10×** | 68 |

| Chuva acumulada | Multiplicador | p90 |
|---|---|---|
| < 1 mm | 1,00× | 2,75× |
| 1–10 | 1,84× | 4,51× |
| 10–25 | 2,72× | 6,60× |
| 25–50 | 3,24× | 6,91× |
| ≥ 50 | 4,46× | 8,12× |

### Como a v2 apresenta o resultado

```
total_esperado = base_total × fator_dia_semana  +  base_clima × (mult − 1)
                 └──── o que o modelo NÃO prediz ┘   └─ o que ele prediz ─┘
```

O sistema separa explicitamente as duas parcelas. Dizer que prediz o total
seria fingir que prevê falha de transformador.

**Exemplo real:** Petrópolis, 11/09/2026, rajada 71 km/h → 5,29× → normal do
dia 44 + **18,5 de acréscimo climático** = ~63 (pior caso 88).
**Rio de Janeiro, 10/09:** normal 730 + **15,6** = 745. No Rio o clima é quase
ruído no volume diário — e o painel mostra isso em vez de esconder.

### ⚠️ O que o modelo ainda não faz

- **Não prediz o total de chamados.** Prediz só a parcela climática.
- **Não prediz clientes sem energia.** Isso está no dataset de *Interrupções*
  (~270 MB/ano), que traz unidades consumidoras afetadas. Ver D10.
- **ERA5 a ~25 km suaviza extremos locais.** Em relevo como o de Petrópolis, a
  rajada real pode ser muito maior que a da reanálise.
- **A faixa ≥ 70 km/h tem 68 dias** de amostra. É o melhor número disponível,
  não um número robusto.

### Decisão de modelagem: o maior fator, nunca o produto

Quando chuva e vento elevam o risco no mesmo dia, a view usa o **maior** dos
dois multiplicadores, não o produto. Chuva e vento num mesmo temporal não são
causas independentes — multiplicá-los superestimaria o risco.

### Também carregado

- **Sazonalidade** (2015–2026): janeiro 120 contra junho 88,5 no índice de
  ocorrências. O mesmo volume de chuva não significa o mesmo em meses diferentes.
- **Dias críticos por ano** (2010–2025): mínimo 622 (2021), máximo 3.270 (2024).
  "Dia crítico" é a definição oficial da ANEEL de evento climático de massa.
- **Baseline por município** dos 92 — de 1,0 (Macuco) a 778,0 (capital).
- **25 dias-município sob emergência declarada**, do cruzamento dos decretos.

### Em produção

`public.tempo_risco_energia` aplica os limiares à previsão consolidada e devolve,
por município e dia: faixa de rajada, faixa de chuva, multiplicador, ocorrências
esperadas, pior caso (p90) e nível de risco.

Exemplo real na primeira execução — **Petrópolis, 11–12/09/2026**: rajada
71–72 km/h → faixa ≥70 → multiplicador 2,39× sobre baseline 58 →
**~139 ocorrências esperadas, pior caso 338. Risco alto.**

## 9.3 Bases de dados de descargas atmosféricas — levantamento (2026-09-11)

Pergunta do usuário: *"deve ter alguma base que tenha histórico e meça a
quantidade de descargas atmosféricas"*. Existe, mas nenhuma serve como driver.

| Fonte | Histórico? | Veredito |
|---|---|---|
| **INPE / ELAT — BrasilDAT** | Sim. Terceira maior rede do mundo, maior dos trópicos. | ❌ O que é público são **rankings municipais anuais em PDF** (raios/km²/ano). Não é série diária. |
| **INPE — `sigma.cptec.inpe.br/raio`** | Tempo real | ❌ Página HTML, sem histórico e sem API. |
| **GOES-16 GLM (AWS S3, `noaa-goes16`)** | Sim, completo, arquivo a cada 20 s | ⚠️ Verificado: ~602 KB por arquivo × 4.320/dia ≈ **2,6 GB/dia, ~950 GB/ano**. Inviável sob a premissa de custo zero. |
| **Blitzortung** | Sim | ⚠️ Licença restringe uso; dados brutos exigem participar da rede. |

### O argumento decisivo

Mesmo com histórico perfeito de raios, **o insumo operacional é uma previsão** —
e nenhum modelo prevê descargas individuais. O driver precisa existir dos
**dois lados**: histórico para calibrar, previsão para predizer.

| Variável | Tem previsão? | Tem histórico? |
|---|---|---|
| Descargas (raio) | ❌ | ✅ | 
| **CAPE** | ✅ (7 de 8 linhagens, máx ~2.800 J/kg) | ❌ **não existe no ERA5** — verificado, 0 de 72 não-nulos |
| Intensidade horária de chuva | ✅ | ✅ | ← **o único com os dois** |

Por isso o driver de raio é a intensidade de chuva. Não é a escolha ideal —
é a única com as duas pontas.

### O caminho para melhorar

Open-Meteo devolve CAPE retroativo via `past_days`: testado, **744/744 horas
em 30 dias** (em 92 dias só 1.081/2.232 — o limite prático é ~45 dias).

Então a rota é acumular CAPE **próprio**: a coleta passa a guardar CAPE junto
com a previsão, e em alguns meses haverá histórico pareado com as ocorrências
mensais da ANEEL. Aí dá para testar se CAPE bate a chuva como preditor de raio.

⚠️ **Estado:** a mudança está escrita em `functions/coletar-previsao/index.ts`
mas **não publicada** — o `deploy_edge_function` do MCP passou a rejeitar
parâmetros booleanos e de array nesta sessão. Republicar quando a ferramenta
voltar. Nada quebra enquanto isso: CAPE não entra em nenhum cálculo atual.

---

### O problema dos 200 MB e sua solução

Um Parquet de 200 MB/ano não cabe no Supabase free, não passa numa Edge Function
e não pode ser processado localmente (P4).

**Solução — destilação como passo de construção, não de execução:**

- **Google Colab gratuito** como bancada descartável: baixa o ano, filtra RJ
  (Light e Enel Rio), agrega, e empurra o **destilado** (poucos MB) ao Supabase.
  Máquina de terceiros, efêmera — não viola P4.
- **Alternativa:** DuckDB + `httpfs` lê Parquet remoto com *predicate pushdown*,
  baixando apenas os *row groups* relevantes.

Roda **uma vez** no bootstrap, e depois 1× por mês se desejado.

---

## 9.4 ✅ MODELO v4 — CALIBRADO CONTRA O TOTAL OBSERVADO (2026-09-11)

### O que quebrou a v3

Uma pergunta do usuário — *"dá para ter uma escala fixa de 0 a 100?"* — expôs um
defeito que nenhuma métrica anterior tinha pego. Os âncoras para a escala
existiam e eram medidos (mediana, p95 e máximo diário por município). O problema
apareceu ao perguntar **até onde o modelo consegue chegar**:

| Município | dia calmo | mediana real | p95 | pior de 2025 | **teto da v3** |
|---|---|---|---|---|---|
| Rio de Janeiro | 730 | 829 | 1.319 | 1.616 | **842** |
| Petrópolis | 52 | 66 | 133 | 375 | **78** |
| Campos | 60 | 99 | 168 | 857 | **75** |
| Teresópolis | 28 | 32 | 65 | 237 | **47** |

Com rajada ≥70 km/h **e** chuva ≥12 mm/h ao mesmo tempo — todos os
multiplicadores no talo — a v3 alcançava em média **60% do p95**. Apenas
**1 município em 92** chegava ao próprio p95.

A causa é aritmética. A v3 dimensionava o acréscimo por **contagem de rótulo**
de causa em dia calmo, e isso é só **7,8%** do total. Multiplicar 7,8% por 6,86
acrescenta no máximo ~46%. Os dias realmente ruins são 2× a 6× a mediana —
fora de alcance por construção.

> **O usuário já tinha desconfiado disso** muito antes, em *"a quantidade de
> ocorrências/dia está baixa"*. Estava certo, e a razão era mais funda que os
> multiplicadores que ajustamos na v2 e na v3.

### A observação do usuário que definiu a correção

*"As distribuidoras classificam erroneamente também."*

Isso fecha o diagnóstico: o rótulo de causa **não é medida de magnitude**, é
ruído com aparência de dado. Numa tempestade, muita queda de árvore entra no
sistema como falha de equipamento. Qualquer modelo que dimensione pelo rótulo
herda o erro de quem digitou.

### O que fica e o que cai

**Fica a ideia física da v3**, que é do usuário e não depende de rótulo: vento e
descarga atmosférica são mecanismos distintos, cada um responde ao seu próprio
driver, e os efeitos **somam**.

**Cai o uso do rótulo para dimensionar.** A pergunta deixa de ser "quantas
ocorrências foram rotuladas como vento?" e passa a ser "**quanto o total do dia
sobe quando a rajada sobe?**".

```
total_esperado = base × fator_dow + base × ( b_vento(rajada) + b_raio(chuva_h_max) )
```

Os `b` saem de uma **regressão conjunta** — as duas faixas na mesma regressão,
o que separa a contribuição de cada driver sem dupla contagem — ajustada contra
o **excedente observado do total diário**, ponderada por `√base` (município
grande tem mais sinal). Absorve automaticamente o que foi classificado errado,
porque nunca olha o rótulo.

### Coeficientes medidos (2025, 92 municípios, 33.580 município-dia)

| Rajada | b | dias | | Chuva máx/h | b | dias |
|---|---|---|---|---|---|---|
| <30 | — | 12.631 | | <1 mm | — | 25.562 |
| 30–40 | +0,115 | 12.557 | | 1–3 | +0,213 | 4.419 |
| 40–50 | +0,183 | 6.263 | | 3–6 | +0,273 | 2.192 |
| 50–60 | +0,285 | 1.650 | | 6–12 | +0,286 | 1.179 |
| 60–70 | +0,402 | 411 | | **≥12** | **+0,330** | 228 |
| **≥70** | **+0,580** | **68** | | | | |

### Resultado

| | v3 | v4 |
|---|---|---|
| viés | −4,53 | **−0,09** |
| teto médio | 60% do p95 | **81% do p95** |
| municípios que atingem o próprio p95 | 1 de 92 | **19 de 92** |
| MAE | 9,96 (só base) | 9,76 |

### A escala 0–100 não funciona — e o motivo importa

Testada, e **satura em 53/100**. Não é falta de calibração: o modelo prevê o
valor **esperado**, e um dia catastrófico é a cauda da distribuição condicional,
não a média dela. Ancorar 100 no p99 criaria um topo inalcançável por
construção — repetindo, em outra roupa, o erro que a v4 foi corrigir.

**O número que funciona é probabilidade:** *chance de o dia entrar nos 10%
piores daquele município*. Vai de **4,4% a 44,0%** conforme o tempo, contra 10%
de climatologia. É fixo, é 0–100, e cai na máquina de calibração que o projeto
já tem (Brier, confiabilidade).

| previsto (rel) | dias | chance de dia ruim |
|---|---|---|
| <1,0 | 6.757 | 4,4% |
| 1,2–1,3 | 7.218 | 10,7% |
| 1,3–1,4 | 3.816 | 14,5% |
| 1,4–1,6 | 3.737 | 20,4% |
| **≥1,6** | 400 | **44,0%** |

### O limite, dito no painel

O tempo explica **12,8%** da variância que sobra depois de descontar porte do
município e dia da semana. O **skill de Brier é 4,2%** sobre a climatologia.
Sinal real e usável — 2,8× de ganho no decil mais alto —, mas modesto: a maior
parte do que faz o telefone tocar não é o tempo. Isso está escrito no cartão,
não escondido.

### Alvo: chamado, não interrupção distinta

O parquet traz `DscNumInterrupcao`, que ligaria o chamado a uma interrupção real
— 1.018.800 chamados para 500.646 interrupções, ~2 por evento. Seria o alvo
fisicamente melhor. **Foi descartado por viés de registro:**

| Distribuidora | chamados | sem id de interrupção |
|---|---|---|
| Light | 560.526 | **72,5%** |
| Ampla | 444.503 | **23,4%** |
| Energisa | 13.771 | 52,0% |

Usar interrupção subcontaria justamente a área da Light — capital e boa parte da
metropolitana. É prática de registro, não física.

---

## 9.5 ✅ RECALIBRAÇÃO COM 4 ANOS (2026-09-11)

Primeira execução do procedimento de `calibracao/`. Resolve o D9 e corrigiu o
número principal do painel.

| | 1 ano (2025) | **4 anos** |
|---|---|---|
| município-dia | 33.580 | **123.648** |
| dias na faixa ≥70 km/h | 68 | **177** |
| municípios que atingem o próprio p95 | 19 | **28** |
| MAE | 9,76 | 9,03 |
| **topo da curva de probabilidade** | **44,0%** | **32,5%** |

**Os 44% eram otimistas.** Vinham de 400 dias; agora são 1.315. O número novo
não é pessimista — o antigo é que estava apoiado em amostra fina, exatamente na
ponta que mais importa.

### Coeficientes

| Rajada | 2025 | 4 anos | | Chuva máx/h | 2025 | 4 anos |
|---|---|---|---|---|---|---|
| 30–40 | +0,115 | +0,092 | | 1–3 | +0,213 | +0,206 |
| 40–50 | +0,183 | +0,162 | | 3–6 | +0,273 | +0,259 |
| 50–60 | +0,285 | +0,223 | | 6–12 | +0,286 | **+0,360** |
| 60–70 | +0,402 | +0,332 | | ≥12 | +0,330 | **+0,392** |
| **≥70** | +0,580 | **+0,615** | | | | |

O vento moderado cedeu; a chuva intensa e a rajada extrema subiram. Com um ano
só, as duas pontas estavam subestimadas.

### Duas armadilhas encontradas

**1. A ANEEL trocou o layout do arquivo a partir de 2026.** Até 2025: `CodIBGE`
(inteiro) e `DthInicioOcorrenciaAberta`, 15 colunas. De 2026: `CodMunicipioIBGE`
e `DthIniOcorrencia`, **23 colunas e tudo como texto**. O script quebrou com
`No match for FieldRef.Name(CodIBGE)`. Agora ele detecta o layout pelo próprio
arquivo. **Não assumir schema estável entre anos.**

**2. O nível de chamados muda muito entre anos — e isso contaminaria tudo.**
Em dia calmo, 2023 está em **77%** de 2025 e 2024 em **90%**. Com base única por
município, essa tendência anual entraria no modelo disfarçada de efeito do tempo:
2023 teria excedente negativo crônico sem chuva nenhuma explicando, e 2025 o
contrário. A base passou a ser por **(município, ano)**, então os coeficientes
saem só da variação *dentro* de cada ano.

O **nível** que vai para produção continua vindo de um ano só — o completo mais
recente (2025) —, porque precisa refletir um ciclo anual inteiro e a operação de
hoje. 2026 ainda não tem outubro a dezembro. Coeficientes de todos os anos,
nível de um: são perguntas diferentes.

---

## 9.6 ✅ CAPE COMO TERCEIRO DRIVER (2026-09-11)

### A conclusão anterior estava certa pela metade

Estava registrado que CAPE só poderia ser testado daqui a meses, porque *"não
existe no arquivo ERA5"*. Verdade — a reanálise devolve a chave de CAPE com
todos os valores nulos, e isso foi re-testado antes de qualquer coisa.

O que faltava: a Open-Meteo tem **duas** portas para o passado. Além do ERA5,
ela arquiva as **previsões** que os modelos emitiram, e esse arquivo
(`historical-forecast-api`) **tem CAPE e volta a 2021**.

E é a régua mais honesta: em produção o sistema consome previsão, não
reanálise. Calibrar contra previsão arquivada mede o driver na mesma régua em
que ele vai ser usado.

### O teste

Mesma estrutura, mesmo número de faixas, mesmos 123.648 município-dia. Só muda
o driver do termo de raio.

| modelo | MAE | viés | R² |
|---|---|---|---|
| vento + chuva *(anterior)* | 9,035 | −0,227 | 0,8538 |
| vento + CAPE | 9,063 | −0,127 | 0,8574 |
| **vento + chuva + CAPE** | **8,971** | **+0,034** | **0,8582** |
| só vento | 9,196 | −0,746 | 0,8516 |

**CAPE sozinho não bate a chuva. Os dois juntos batem os dois sozinhos.**

A correlação entre `chuva_h_max` e `cape_max` é apenas **+0,33** — carregam
informação diferente, e por isso somar vence escolher. Os coeficientes de chuva
**caem** quando o CAPE entra (1–3 mm: +0,206 → +0,162): parte do que se
atribuía à chuva era convecção mal alocada.

| Rajada | b | | Chuva máx/h | b | | CAPE | b |
|---|---|---|---|---|---|---|---|
| 30–40 | +0,045 | | 1–3 | +0,162 | | 200–500 | −0,007 |
| 40–50 | +0,116 | | 3–6 | +0,191 | | 500–1k | +0,059 |
| 50–60 | +0,190 | | 6–12 | +0,275 | | 1k–2k | +0,139 |
| 60–70 | +0,305 | | ≥12 | +0,309 | | **≥2k** | **+0,180** |
| **≥70** | **+0,586** | | | | | | |

Ganho em erro: 0,7%. **O que melhora de verdade é o viés**, que vai a zero, e o
alcance: 28 → **31 municípios** atingem o próprio p95. Custo operacional zero —
a coleta de CAPE já rodava desde a manhã.

Ressalva registrada sem massagem: a faixa 200–500 J/kg deu **−0,007**,
tecnicamente quebrando a monotonicidade. É 4% da amplitude, dentro do ruído de
17.441 dias.

### Consolidação entre linhagens

As famílias discordam na ordem de grandeza (mediana ECMWF 460 J/kg contra 30 do
GFS) porque cada centro define CAPE de um jeito e a Open-Meteo não normaliza.
A **mediana entre famílias** neutraliza isso, e a distribuição resultante em
produção foi verificada contra a do arquivo de calibração: mesma escala.

O CAPE é consolidado exatamente como a chuva já era — mediana entre famílias
por hora, depois máximo do dia.

### Dois tropeços de engenharia

**Timeout.** Varrer o JSONB uma segunda vez levou `risco_energia` a 2,97 s
contra o limite de 3 s do `anon`, e o cartão sumiu do painel. Mover o CAPE para
dentro do `consolidado` baixou para 2,2 s — ainda raspando. A solução foi
**snapshot atualizado a cada 20 min** (`tempo.risco_snapshot`), o mesmo remédio
que já tinha resolvido o `tempo_status`: recalcular a cada carregamento era
desperdício, já que os dados só mudam 4× por dia. Resultado: **0,2 s**.

**POLICY ≠ GRANT, pela terceira vez.** Criei a política RLS da tabela nova e
esqueci o `grant select ... to anon`. São mecanismos separados e o `anon`
precisa dos dois; a view pública é `security_invoker` e devolveu 401. Ver R11 e
R12 — esta é a terceira porta do mesmo problema.

---

## 9.7 ✅ OS PESOS ENTRARAM EM VIGOR (2026-09-28)

O princípio §5.2 — *o peso vem de skill medido, não de opinião* — deixou de ser
promessa em **2026-09-28**. `pesos_em_uso = true`.

### O caminho até aqui

| Data | Verificações | Grupos com peso |
|---|---|---|
| 2026-09-12 | 18.128 | 0 — travados em **24 horas distintas** de 72 |
| 2026-09-15 | 53.392 | 0 — o mais adiantado em 57 de 72 |
| 2026-09-28 | **204.120** | **9 de 24** |

O gargalo foi sempre a trava de horas, nunca a de amostras: em 12/09 o grupo
líder já tinha **349 comparações** contra as 30 exigidas, e mesmo assim não
decidia nada. Era exatamente o efeito que a trava existe para produzir. Ver a
decisão de 2026-09-11 sobre pseudo-replicação em §15.

Ativos hoje: as **oito regiões na faixa 0-6h** (336 a 351 horas distintas) mais
a Metropolitana em **6-24h**. Três grupos estão a uma hora de fechar.

### O ranking medido — 25.078 comparações por linhagem

| Família | Erro médio (mm/h) | Viés | Lidera em |
|---|---|---|---|
| **DWD ICON** | 0,271 | −0,061 | 12 de 24 |
| NOAA GFS | 0,311 | +0,003 | 5 |
| Météo-France ARPEGE | 0,322 | +0,027 | 1 |
| ECMWF IFS 0.25° | 0,340 | +0,060 | 1 |
| CMA GRAPES | 0,351 | +0,045 | 2 |
| UK Met Office | 0,363 | +0,084 | 3 |
| JMA GSM | 0,389 | +0,120 | 0 |
| CMC GEM | 0,418 | +0,148 | 0 |

Três leituras que valem registro:

**O viés ordena a tabela.** A correlação entre viés e erro é quase perfeita:
quem prevê chuva a mais erra mais. O ICON lidera com o único viés negativo; o
GEM é o último com o maior viés positivo. Não foi imposto pelo método — a
regressão de peso só olha MAE — e por isso é um achado, não um artefato.

**O ECMWF está em quarto.** O modelo de maior prestígio do mundo não é o melhor
*aqui, nesta escala, para chuva horária*. É precisamente o motivo de medir em
vez de supor, e a refutação mais limpa que o projeto produziu de uma intuição
que todo mundo teria.

**O ranking não mudou com 15× mais dados.** A ordem medida em 15/09, com
25 mil comparações no total, sobreviveu às 204 mil. Estabilidade é evidência de
sinal, não de sorte.

### Os pesos em vigor

`peso = max(0,25 ; (melhor_mae + 0,1) / (mae + 0,1))`, dentro de cada grupo.

Na prática vão de **1,00** (o líder do grupo, que não é penalizado) a **0,58**
(GEM no seu pior grupo). O piso de 0,25 — criado para nunca silenciar uma
linhagem que possa ser a única a acertar o evento raro — **nunca chegou perto de
ser tocado**. O amortecimento de +0,1 no numerador e no denominador foi o que
segurou isso: sem ele, um grupo de chuva fraca com MAE 0,05 contra 0,40 daria
peso 0,12.

### Um número errado, achado ao conferir

`skill_grupos_ativos` contava **linhas** de `tempo.skill`, que são
(grupo × linhagem). Com 9 grupos e 8 linhagens o painel exibia **"72 grupos
atingiram amostras suficientes"** — mais grupos do que os 24 que existem no
total, e sob um rótulo que dizia explicitamente *região × variável × horizonte*.

Corrigido na migration **065**: conta grupos distintos. O texto do painel também
estava incompleto — dizia "amostras suficientes" quando são duas travas, e não
dizia o que acontece nos grupos restantes.

Lição, que é a mesma de sempre neste projeto: **o número certo sob o rótulo
errado é um número errado.** Só apareceu porque a trava disparou e alguém foi
ler a frase inteira.

### O ranking depende do horizonte (2026-10-02)

Primeiro fruto da migration 067: com as faixas longas medindo, dá para comparar
as linhagens **por antecedência**. MAE em mm/h, ponderado por amostras.

| Família | 0-6h | 6-24h | 24-72h |
|---|---|---|---|
| **DWD ICON** | **0,282** | **0,354** | **0,569** |
| NOAA GFS | 0,308 | 0,362 | 0,619 |
| ECMWF IFS | 0,313 | 0,414 | 0,689 |
| Météo-France ARPEGE | 0,317 | **0,464** ↓ | 0,657 |
| CMA GRAPES | 0,332 | 0,426 | 0,633 |
| JMA GSM | 0,342 | 0,525 | 0,795 |
| UK Met Office | 0,353 | **0,386** ↑ | 0,658 |
| CMC GEM | 0,433 | 0,432 | **0,967** |

Três leituras:

**O ICON lidera em todas as faixas.** Não é artefato de uma janela curta — a
vantagem sobrevive de 6 horas a 3 dias.

**O ARPEGE desaba com a antecedência.** É 4º em 0-6h e 7º em 6-24h. Coerente
com a física: o ARPEGE é modelo de curto prazo e área limitada, e perde valor
justamente onde o global manda. O inverso acontece com o UKMO, que sobe de 7º
para 3º. Nenhum dos dois efeitos era visível com uma faixa só, e os dois são
argumento direto a favor de pesar **por grupo (região × horizonte)** em vez de
um peso único por modelo — decisão tomada em 2026-09-10 por princípio, agora
confirmada por medida.

**O erro dobra de 0-6h para 24-72h** (0,282 → 0,569 no ICON). Dimensiona quanto
vale a pena confiar no quarto e no quinto dia do painel.

⚠️ A coluna de 24-72h repousa em ~150 amostras por grupo, contra 8.290 em
0-6h. É indicativa, não firme. A de 72-120h ainda não ativou: 27 das 72 horas,
crescendo ~12 h/dia.

### O que isto ainda não é

Peso medido é a camada 1 (chuva). A camada 3 (impacto elétrico) continua
**calibrada mas não verificada** — `impacto_pares_verificados = 0`, com 21 dias
de previsão congelada esperando o lote da ANEEL. Ver §10.1 e R10.

---

## 9.8 ✅ CALIBRAÇÃO MEDIDA E MOSTRADA (2026-09-28)

A §5.4 diz que *probabilidade sem calibração é mentira educada*. Era promessa
escrita: `tempo.atualizar_calibracao()` rodava às 04:50 desde o início, a tabela
enchia todo dia, e **nada no painel a lia**.

### O que ela diz — 25.078 horas conferidas

| O painel anuncia | Choveu de fato | Horas |
|---|---|---|
| 0% · 0 de 8 | 2,5% | 16.184 |
| 12,5% · 1 de 8 | 7,0% | 2.819 |
| 25% · 2 de 8 | 13,3% | 1.536 |
| 37,5% · 3 de 8 | 17,9% | 1.214 |
| 50% · 4 de 8 | 18,6% | 954 |
| 62,5% · 5 de 8 | 27,7% | 917 |
| 75% · 6 de 8 | 34,9% | 751 |
| 87,5% · 7 de 8 | 41,0% | 532 |
| **100% · 8 de 8** | **43,3%** | 171 |

O painel é otimista por um fator de ~2 em toda a escala.

### O número que dói

```
frequência base      8,0%
Brier climatologia   0,0735
Brier como está      0,0869   →  skill −18%
Brier calibrado      0,0637   →  skill +13%
```

**Lida como probabilidade, a fração de concordância informa menos do que
repetir "8%" todo dia.** Mas a coluna observada é **monotônica** — 2,5 → 7 →
13 → 18 → 19 → 28 → 35 → 41 → 43 — o que significa que o painel *ordena* muito
bem e está apenas na escala errada. É o caso que uma tabela de tradução
conserta, e conserta para skill positivo.

### O que é erro e o que é escala

Parte da diferença **não é erro do modelo**: ele prevê chuva numa célula de
13–25 km e o pluviômetro mede um ponto. Área contra ponto derruba a frequência
observada por construção — é o mesmo motivo que levou, em 2026-09-10, a adotar
a mediana entre estações como observado.

Não dá para separar as duas parcelas com o que existe hoje, e o documento não
finge que dá. Para quem lê o painel, porém, a consequência é idêntica: quando
ele diz 100%, choveu na estação em 43% das vezes. É isso que passou a ser dito.

### O que foi construído

`public.tempo_calibracao` (migration 066) — as nove faixas mais os três Brier
como colunas de janela, para a **fórmula viver no banco e não no JavaScript**.
O painel mostra em três lugares:

1. **Cartão principal** — uma linha sob a contagem: *"historicamente, isto virou
   chuva em 43% das vezes"*. A fração de concordância continua ali, porque
   responde a outra pergunta; as duas cabem.
2. **Tooltip do mapa de chuva** — *"6 de 8 famílias preveem chuva · medido: 35%
   viraram chuva"*.
3. **Monitor**, terceira seção — a tabela inteira com o Brier contra a
   climatologia, dito nos dois modos.

A busca é pela probabilidade **mais próxima**, não por índice: se um dia entrar
uma nona família, as frações deixam de ser k/8 e um índice fixo apontaria para
a faixa errada em silêncio.

### Temperatura no topo

No mesmo dia, com alerta de **GRANDE PERIGO por onda de calor vigente**, os
quatro números do topo do painel eram `0%`, `0%`, `0,0 mm` e `48 km/h` — a
história do dia estava invisível. Entrou um quinto tile com máxima e mínima de
24 h, a partir do `temp_mediana` que já vinha na mesma consulta.

Sem etiqueta de "calor extremo" por limiar fixo: o alerta do INMET já está no
cartão acima e, pela §5.3, órgão oficial **sobrepõe** a previsão. Um limiar meu
que não dispara durante um GRANDE PERIGO vigente seria lido como "não há
problema" — a §5.8 de novo.

### O que continua sem medida

Os 24 grupos de skill são **todos de chuva**. O CEMADEN só mede chuva, então
vento e temperatura não têm como ganhar peso por esse caminho — e a rajada é um
dos três drivers da camada 3, ou seja, **entra no cálculo de risco sem nunca ter
sido verificada**. **O Alerta Rio foi investigado e descartado em 2026-09-28**, por decisão do
usuário. Tem vento: oito estações meteorológicas (Vidigal, Irajá, Jardim
Botânico, Barra/Riocentro, Guaratiba, Santa Cruz e mais duas). Mas a feed
pública que já consumimos (`/json/chuvas`) traz só `kind: "pluviometric"` —
chuva, 33 estações, nenhum campo de vento; as páginas ao vivo das
meteorológicas exigem login; e o único acesso público é um arquivo histórico
por estação-ano (1997–2026), via formulário POST. Daria série longa da capital,
não ciclo diário. Oito estações numa cidade só, com download manual, não pagam
o custo de manutenção.

O candidato que resta é o INMET (26 estações automáticas no RJ, §16),
mas em 2026-09-28 `apitempo.inmet.gov.br` aceitou a conexão e a derrubou em
seguida (`Connection reset`), tanto na lista de estações quanto na série
horária. Precisa ser testado de outra rede antes de virar plano.

---

## 10. Verificação de impacto — ⛔ REMOVIDA em 2026-09-10

> **Decisão do usuário: o botão "faltou luz aqui" foi removido.**
>
> Consequência assumida: a camada de impacto perde a **validação contínua**.
> Ela ainda pode ser *treinada* com o histórico da ANEEL (§9), mas não terá
> como saber se está acertando no presente — o loop de verificação da camada 3
> fica aberto.
>
> Ganho colateral: some a única superfície de **escrita** exposta ao `anon`,
> e com ela o único `SECURITY DEFINER` chamável sem autenticação. A tabela
> `tempo.reporte_falta_luz` e a função permanecem no banco, sem grant e sem
> policy — inacessíveis publicamente, prontas caso o botão volte.
>
> O texto abaixo fica como registro do desenho original.

### Desenho original (inativo)

Não existe fonte pública, automatizada e em tempo real de interrupções no RJ
(salvo o RADAR, ainda não confirmado). Light e Enel têm mapas próprios sem API
aberta; a ANEEL publica DEC/FEC apenas agregado.

**Decisão:** um botão no HTML — **"faltou luz aqui agora"** — dois cliques
(bairro + horário), gravando no Supabase.

Com 3 pessoas em bairros distintos ao longo de meses, obtém-se um conjunto de
verificação pequeno mas **real**. Custo zero, volume irrisório. É, provavelmente,
o ativo mais original que o projeto pode gerar: um dado que não existe
publicamente.

---

## 10.1 ✅ VERIFICAÇÃO DO IMPACTO — o conserto da amnésia (2026-09-11)

O princípio §5.4 diz que probabilidade sem calibração é mentira educada. A
camada 3 vivia fora dele: publicava "32,5% de chance de dia ruim" e ninguém
conferia.

**O diagnóstico corrente estava errado.** A explicação que eu vinha repetindo —
*"não dá para verificar porque a ANEEL publica em lote"* — descrevia um atraso,
não um impedimento. Dado que chega atrasado ainda é dado.

O impedimento real era outro: `tempo.risco_energia` é uma **view calculada na
hora**. Nada guardava o que o painel tinha dito. Quando o lote chegasse, não
haveria com o que comparar — e previsão não gravada é previsão perdida para
sempre. Cada dia que passava era um dia que nunca mais se verificaria.

### O que foi construído

| Objeto | Papel |
|---|---|
| `tempo.impacto_previsto` | Congela a previsão. Vetor de 6 posições por (município, dia alvo): índice 1 = previsto no próprio dia, índice 6 = com 5 dias de antecedência |
| `tempo.impacto_snapshot()` | Cron diário às 10:00 BRT, depois da coleta das 09:30 |
| `tempo.impacto_observado` | O que aconteceu, carregado do lote da ANEEL |
| `tempo.impacto_param` | `limiar_dia_ruim` = 2,19. Fora do código, para reescorar sem recarregar |
| `tempo.impacto_pontuar()` | Brier e confiabilidade **por antecedência** |
| `tempo.impacto_skill` · `tempo.impacto_confiabilidade` | O placar |

Formato em vetor, mesma economia de `tempo.observacao_dia`: 92 linhas/dia em
vez de 552. Dois anos de retenção cabem em ~67 mil linhas.

### Calibrar ≠ verificar

Calibrar ajusta o modelo ao passado; verificar confere se a previsão **que foi
ao ar** acertou. Usar o mesmo dado para as duas coisas seria medir o modelo com
a própria régua. Por isso o passo 4 do procedimento só aceita dias que já
tinham previsão congelada *antes* de o dado chegar.

### Estado, e por que há zero pares (investigado em 2026-10-02)

**25 dias congelados, nenhum verificado.** Vinte e seis dias de silêncio
levantaram a suspeita de que a fonte tinha mudado. Não mudou — e o diagnóstico
tem três camadas, duas invisíveis até alguém procurar.

**1. O vigia está certo.** Aponta para `ced06b4c-...`
(*ocorrencias-emergenciais-nas-redes-de-distribuicao*), o dataset dos chamados,
que é o que a camada 3 usa. Na investigação eu comparei primeiro contra
`ccb25653-...` (*interrupcoes-de-energia-eletrica*) e conclui que "nenhum dos 10
recursos existe mais" — falso alarme. São **dois datasets diferentes**, ambos
com 21 recursos e nomes parecidos; o segundo é o do D10, de unidades
consumidoras afetadas. Ficou anotado no cabeçalho do `7_espiar_aneel.py`.

**2. A ANEEL publicou, mas o arquivo não alcança as previsões.** O parquet de
2026 saiu em **10/09** e cobre **competência janeiro a agosto**. As previsões
congeladas começam em **11/09**. Nenhuma delas é verificável contra esse
arquivo — não é atraso nosso, é dado que ainda não existe.

Medido sem baixar os 195 MB: o rodapé do parquet guarda min/max por coluna e o
servidor aceita HTTP Range. **149 KB** resolveram. Virou ferramenta em
`calibracao/7_espiar_aneel.py`.

Pelo padrão observado — publicação em 10/09 cobrindo até agosto —, setembro
deve aparecer por volta de **10/10**. É inferência de **uma** observação, não
cadência confirmada.

**3. O que teria mordido em silêncio:** `tempo.impacto_observado` está
**vazia**, e nada a preenche sozinho. A carga é o script manual
`4_carregar_observado.py` — 195 MB de parquet não cabem em Edge Function.
"Esperando a ANEEL" era só metade da verdade: quando o arquivo chegar, alguém
ainda precisa rodar o passo 4. Não há automação prevista, e pelo custo nem
deveria haver; mas precisa estar escrito, senão vira espera eterna.

**Sujeira conhecida na fonte:** `DthIniOcorrencia` tem máximo em 2026-12-02 e
`DthFimOcorrencia` em 2029 — digitação errada das distribuidoras. O passo 4 é
imune: carrega tudo e deixa o SQL filtrar pelos dias que tinham previsão
congelada.

O painel declara isso em texto no cartão de impacto, em vez de exibir um número
como se fosse aferido.

### Primeira verificação de verdade (2026-11-13)

**O atraso da ANEEL é de ~2 meses, não 1.** Setembro só saiu em **12/11**; a
inferência de "por volta de 10/10" estava errada.

**O robô (`aneel.yml`) não conseguiu buscar.** Em 11/11 e 13/11 o site da ANEEL
derrubou a conexão vinda do GitHub (SSL EOF, depois timeout ×4 com as novas
tentativas). Daqui de casa baixou na primeira. Parece bloqueio de faixa de IP de
datacenter, não instabilidade. **Setembro foi carregado à mão** (passo 8 rodado
localmente). Se o bloqueio persistir, outubro também vai precisar disso, por
volta de meados de dezembro.

**`impacto_pontuar()` nunca tinha rodado e estava quebrada** (corrigida na
`sql/100`): DELETE/UPDATE sem WHERE, que o Supabase barra quando a chamada vem
pela API, e `brier` ambíguo entre a coluna de saída e a da tabela.

**Resultado — 663 pares, 20 dias (11 a 30/09), um mês seco:**

| antecedência | pares | Brier | Brier clim. | skill |
|---|---|---|---|---|
| hoje | 663 | 0,0847 | 0,0848 | +0,1% |
| D+1 | 629 | 0,0792 | 0,0798 | +0,7% |
| D+2 | 596 | 0,0806 | 0,0796 | −1,2% |
| D+3 | 565 | 0,0852 | 0,0836 | −2,0% |
| D+4 | 524 | 0,0894 | 0,0894 | 0,0% |

Taxa observada de dia ruim: ~9%. **Skill zero:** em setembro, a probabilidade de
dia ruim não foi melhor que dizer sempre "9%". A climatologia de referência é a
taxa do próprio período, o que a torna difícil de bater. Confiabilidade (hoje):
abaixo de 8% previsto deu 4,8% observado (bom); 12–18% deu 16,4% (bom); mas
18–28% deu só 11% e ≥28% deu 14% (só 7 pares). **As faixas altas superestimam.**
Vinte dias secos não bastam para concluir nada; a leitura honesta é "ainda sem
evidência de acerto", não "não funciona".

---

## 11. Ordem de construção

**(a) chuva → (c) energia → (b) deslizamento**

| Ordem | Entrega | Justificativa |
|---|---|---|
| **1º — (a)** | "Vai chover forte nas próximas 6 h aqui?" | Pré-requisito físico de todo o resto. É a fundação. |
| **2º — (c)** | "A luz vai cair hoje?" | Viabilizado pelos 8 anos da ANEEL. É o **diferencial real** — não existe montado publicamente para o RJ. |
| **3º — (b)** | "Risco de deslizamento na Serra?" | **Terceirizado ao CEMADEN.** Exige dado geotécnico, declividade, saturação e ocupação. O CEMADEN já faz bem, com rede própria. Competir seria desperdício — melhor **consumir o alerta deles** como camada 2. |

---

## 12. Stack e infraestrutura

| Componente | Escolha | Observação |
|---|---|---|
| **Backend / banco / cron / proxy** | Supabase **`PregadorAPP`** (`hmwevcpcelmwnonbeojy`, `us-east-1`), **schema `tempo` isolado** | ⚠️ **`legno-lp` intocado.** O plano free trava em 2 projetos ativos (R7), então o TEMPO virou schema separado dentro do PregadorAPP. Nada em `public` do app bíblico foi alterado, salvo 4 funções prefixadas `tempo_*` (§7 abaixo). |
| **Front** | HTML standalone na **Vercel** | `tempo-rj-luis-claudio-lopes-da-cruzs-projects.vercel.app` |

### Estado da implantação (2026-09-11)

| Item | Estado |
|---|---|
| Schema `tempo` | ✅ 22 tabelas, RLS em todas, retenção, 35 migrations |
| 92 pontos (sedes municipais do RJ) | ✅ IBGE + geocodificação, validados |
| 8 linhagens de modelo | ✅ verificadas empiricamente contra a API |
| Edge Function `tempo-coletar-previsao` | ✅ **v3** (2026-09-11), autenticada por segredo próprio, agora com **CAPE** |
| `pg_cron` | ✅ 9 jobs — ver tabela de horários abaixo |
| Primeira coleta real | ✅ **736 linhas** (92 × 8) em 12,6 s, zero erros |
| Views de fusão | ✅ probabilidade por família, testada |
| Front na Vercel | ✅ publicado |
| **Camada 2 — observação** | ✅ Alerta Rio (33 pluviômetros na capital) **+ CEMADEN (~204 estações vivas, 64 municípios)**, coleta horária |
| **Camada 2 — alertas oficiais** | ✅ INMET, filtrado ao RJ, com o texto de `riscos` |
| **Bloco [5] — verificação** | ✅ `tempo.verificar()`, horária, **multifonte**. Primeira rodada com CEMADEN: **984 pares novos**, as 8 regiões do estado |
| **Skill / pesos** | ✅ `tempo.atualizar_skill()` diária; piso duplo — 30 amostras **e** 72 horas distintas (anti-pseudo-replicação) |
| **Calibração (Brier)** | ✅ `tempo.atualizar_calibracao()` diária |
| **Camada 3 — impacto** | ✅ **três drivers** (vento + chuva + convecção), 123.648 município-dia. Servido por snapshot, 0,2 s. Ver §9.4 a §9.6 |
| **Normal climatológica** | ✅ `tempo.clima_normal` 1991–2020 (ERA5), **92 de 92 municípios**, 1.104 linhas. Baixada em duas etapas: a cota horária da Open-Meteo estourou no meio e o script retomou na hora seguinte |
| **Varredura semanal da ANEEL** | ✅ quartas 06:00/06:05 — vigia `last_modified` no CKAN sem baixar nada e levanta bandeira quando há dado novo |
| **Procedimento de recalibração** | ✅ escrito, testado e reprodutível em `C:\TEMPO\calibracao\` |
| **CAPE (energia convectiva)** | ✅ **gravando desde 2026-09-11 09:30 BRT.** 644 de 736 linhas por emissão (92 pontos × 7 linhagens; a JMA devolve a chave só com nulos e a guarda a descarta). Não entra em cálculo nenhum hoje — é lastro para o D11. |
| **Retenção** | ✅ `tempo.observacao_dia` 120 dias (como a observação horária) e `tempo.cemaden_req` 7 dias — a fila do `pg_net` não expira sozinha, só as respostas |
| Migrations | 55 aplicadas |
| Edge Functions | 3 (`previsao`, `observacao`, `tempo-rj` inerte) |
| Jobs `pg_cron` | 13 ativos |
| Front — alertas oficiais | ✅ ordenados por gravidade, com texto de risco |
| Front — risco de impacto | ✅ 5 dias, nível + multiplicador + ocorrências esperadas |
| Front — status de aprendizado | ✅ o painel declara que ainda não tem pesos |
| **Painel — legenda e cores do risco** | ✅ **Publicado e conferido em 2026-09-11** (byte a byte idêntico ao local, mesmo `sha256`). Correções: (1) a barra pintava o segmento de vento pelo *nível do dia* e o de raio por *causa* — duas dimensões no mesmo canal de cor, o que tornava vento-normal indistinguível de raio; agora **cor = causa** (azul vento, violeta hachurado raio) e a gravidade vive só na palavra colorida; (2) legenda explicando as duas cores, as quatro gravidades e o fato de a barra ser proporcional ao **pior dia da janela**, não a escala fixa; (3) leitura numérica em dois níveis; (4) **`MODERADO` vazava por baixo da barra** — a coluna da data era fixa em 78px com conteúdo variável, e `NORMAL`/`ALTO` só escapavam porque o respiro de 12px absorvia a sobra; agora 92px, palavra em linha própria e `overflow:hidden` como trava; (5) coluna única no celular. |
| Proteção de login da Vercel | ✅ **desligada** — site público e validado de ponta a ponta |

**Linter de segurança:** sem achados meus em aberto. O `ERROR` de
`SECURITY DEFINER VIEW` em `tempo_status` foi eliminado trocando a view por um
**snapshot** atualizado por job interno — o `anon` lê uma tabela comum, sem
escalação de privilégio em ponto algum. Os achados remanescentes são todos do
`PregadorAPP` (ver D6).

### 12.1 Estado da implantação (2026-09-28)

| Item | 2026-09-11 | 2026-09-28 |
|---|---|---|
| Migrations | 55 | **65** |
| Tabelas em `tempo` | 22 | **34** |
| Views públicas `tempo_*` | 3 | **12** |
| Jobs `pg_cron` | 13 | 13 |
| Edge Function `tempo-coletar-previsao` | v3 (CAPE) | **v4 — + `cloud_cover`** |
| Pesos por skill | ❌ todos iguais | ✅ **9 de 24 grupos**, ver §9.7 |
| Verificações acumuladas | ~1.000 | **204.120** |
| Schema `tempo` | 4,4 MB | **132 MB** |
| Banco inteiro (compartilhado) | 144 MB | **280 MB de ~500** |

⚠️ **O orçamento apertou mais rápido que a projeção.** A §6 previa ~71 MB em
regime permanente para o `tempo`; são 132 MB. Duas causas, ambas conhecidas e
nenhuma anômala: `tempo.previsao` está em **98 MB** com 27.968 linhas (a
retenção de 10 dias funciona — o número de linhas bateu a projeção; o que errou
foi o custo por linha, ~3,5 KB, porque TOAST comprime menos do que eu supus e o
`cloud_cover` acrescentou uma sétima série) e `tempo.verificacao` em **24 MB**
com 201 mil linhas. Ver R13.

### 12.2 O painel — navegação e cartões (2026-09-15 a 2026-09-28)

**Busca de município no lugar do seletor.** O `<select>` obrigava a rolar 92
itens. Virou campo de texto que filtra conforme se digita, **ignorando acento e
caixa**: `sao gon` acha São Gonçalo, `petro` acha Petrópolis. Não é o
`<datalist>` nativo — ele não normaliza acento, e num estado com Guapimirim,
Paraíba do Sul e Conceição de Macabu é justamente o que mais atrapalha. São
~50 linhas de JS, sem biblioteca.

**Região e concessionária: pedidas, construídas, e uma delas removida.** O
usuário pediu três filtros encadeados (concessionária → região → município) e
um Top-5 de risco. Foram construídos os quatro, inclusive
`tempo.municipio_distribuidora` (mapeamento por ANEEL, com municípios divididos
entre duas distribuidoras — Petrópolis é 87% Light / 11% Enel) e
`ponto.regiao_painel` (as regiões **como as distribuidoras e o senso comum
dividem**, não as oficiais do estado: Região dos Lagos e Costa do Sol separadas,
por lista do próprio usuário).

Depois o usuário mandou **tirar o filtro de região** e deixar só municípios em
ordem alfabética. A razão é boa e vale como princípio: *filtro hierárquico exige
saber a geografia antes de achar o que se procura*. Quem quer Nova Friburgo não
deveria precisar lembrar que ela é Serrana.

O que sobrou dos dois: a região vira **subtítulo** de cada item do Top-5 e de
cada linha da busca, e a concessionária vira um **resumo agregado** no panorama
("quantos municípios de cada distribuidora estão acima do normal hoje"). Ou
seja: continuam informando, deixaram de filtrar. Dado deletado seria perda;
dado promovido a rótulo é ganho.

**Cartão "Como o tempo deve ficar, hora a hora"** (migration 063). Resolve o
§5.8(b). Ícones em SVG — sol, lua, sol entre nuvens, nublado, encoberto, garoa,
chuva, chuva forte, tempestade — desenhados a partir da **mediana das 8
famílias** para cobertura de nuvem e chuva na mesma hora.

Regra de precedência: **chuva manda no ícone; sem chuva, quem decide é a
nuvem.** Chove com o céu carregado, e mostrar "encoberto" numa hora de chuva
esconderia o que importa. À noite sol vira lua: Rio fica no trópico, nasce ~6h e
põe ~18h o ano todo, então não vale puxar efeméride.

Exigiu coletar `cloud_cover`, que não estava sendo guardado. Verificado antes de
mexer: **as 8 linhagens publicam**, 48 de 48 horas válidas. Na primeira coleta
apareceu um caso que ilustra bem o §5.1 — para a mesma hora no Rio, o CMA dizia
**0%** de nuvem enquanto as outras sete diziam de 83% a 100%.

**Monitor de aprendizado e desempenho** (migrations 062 e 064). Dois blocos
atrás de um botão, no fim do cartão "Como ler isto":

- *Andamento* — por grupo, as duas travas em barras (30 comparações, 72 horas),
  com o líder parcial. Quando a diferença entre o melhor e o pior MAE é menor
  que 0,1, a coluna diz **"ainda empatados — choveu pouco: todos acertam
  prevendo zero"** em vez de coroar alguém. Ranking construído sobre um período
  seco engana, e monitor que engana é pior que monitor nenhum.
- *Desempenho* — o ranking das 8 linhagens com MAE ponderado por amostras, viés
  em palavras ("prevê chuva a mais") e em quantos grupos cada uma lidera.

A decisão de projeto aqui: **mostrar a medição antes de ela valer, marcada como
provisória.** O sistema sabe quem erra menos muito antes de poder agir, e
esconder isso até a trava abrir seria tratar o usuário como quem não aguenta um
número com ressalva. O cartão diz, em destaque, *"medido, mas ainda sem
efeito"*.

Custo: ambas as views agregam ~192 linhas de `tempo.skill` em **2,5 ms** — não
precisaram de snapshot como o `risco_energia` precisou.

### Fuso horário — verificado em 2026-09-11

O `pg_cron` **só aceita UTC**; não há o que configurar. O que importa é que o
agrupamento por dia seja civil local, e é: `tempo.risco_energia` (camada 3) e
`tempo.observacao_dia` (CEMADEN) usam `AT TIME ZONE 'America/Sao_Paulo'`
explicitamente, e o painel formata com `getHours()`/`getDate()`, que renderizam
no fuso do navegador. Se a camada 3 agrupasse em UTC, a "chuva do dia"
começaria às 21h do dia anterior e os multiplicadores cairiam no dia errado.

| Job | BRT | UTC |
|---|---|---|
| Coleta de previsão | **03:30 · 09:30 · 15:30 · 21:30** | `30 0,6,12,18` |
| Observação (Alerta Rio) | todo :05 | `5 * * * *` |
| CEMADEN — dispara / recolhe | todo :08 e :12 | `8` / `12 * * * *` |
| Verificação | todo :25 | `25 * * * *` |
| Status | a cada 15 min | `*/15` |
| Retenção | 00:15 | `15 3` |
| Skill | 01:40 | `40 4` |
| Calibração | 01:50 | `50 4` |
| **Varredura ANEEL** | **quarta 06:00 / 06:05** | `0 9 * * 3` / `5 9 * * 3` |
| **Congelar previsão de impacto** | **10:00** | `0 13 * * *` |
| **Snapshot do risco** | a cada 20 min | `*/20 * * * *` |

**Endereço do painel:** https://tempo-rj.vercel.app
(alias longo: https://tempo-rj-luis-claudio-lopes-da-cruzs-projects.vercel.app)

**Publicação:** automática a cada push no `main` (GitHub ligado à Vercel em 16/11/2026), com **Root Directory = `web`**. Sem isso o painel sai em `/web/` e a raiz dá 404. O painel não é indexado: `<meta name="robots">` no HTML e `X-Robots-Tag` em `web/vercel.json`.

⚠️ **Limitação do conector Vercel:** o token do MCP publica deploys, mas recebe
`403 — must re-authenticate to this scope` em qualquer alteração de configuração
do projeto. Mudanças em settings precisam ser feitas pela UI.

**Superfície criada em `public`** (mínima e prefixada, para não mexer na config
do projeto): `tempo_alvos_coleta()`, `tempo_ingerir_previsao()`,
`tempo_log_coleta()` (todas só `service_role`), `tempo_reportar_falta_luz()`
(sem grant desde a remoção do botão), e as views `tempo_municipios`,
`tempo_previsao`, `tempo_alertas`.

**Volume medido (2026-09-11).** Uma coleta completa custava 1,36 MB; com o CAPE
passa a **~1,71 MB** (medido no payload real: CAPE são inteiros de 4 dígitos,
não decimais curtos, e acrescenta **25,6%** ao blob). Com retenção de 10 dias e
4 coletas/dia, a previsão vai de ~54 MB para **~68 MB** antes da compressão TOAST.

O CEMADEN acrescenta **~3 MB** nos 120 dias de retenção, porque grava vetor de
24 horas por município/dia (~64 linhas/dia) e não uma linha por leitura
(~3.000/dia, que custariam ~125 MB).

⚠️ **O orçamento de 500 MB é compartilhado com o PregadorAPP.** O banco inteiro
está hoje em **144 MB**, dos quais o schema `tempo` são apenas 4,4 MB — o resto
é do outro projeto. Em regime permanente o TEMPO deve ocupar ~71 MB, levando o
total a ~210 MB. Folga confortável, mas não são 500 MB só nossos.
### Componentes de apoio — fora do runtime

| Componente | Escolha | Observação |
|---|---|---|
| **Destilação histórica** | Google Colab gratuito ou DuckDB/httpfs | Passo de bootstrap, não de runtime |
| **Armazenamento frio** (se necessário) | Cloudflare R2 (10 GB grátis) | Plano B se os 500 MB apertarem |
| **Alerta ativo** (a decidir) | Serviço de e-mail via conector | Ver §14 |

### Conectores disponíveis e seu papel

**Em uso:** Supabase (backend completo, migrations, Edge Functions, RLS,
`get_advisors` para lint de segurança) · Vercel (hospedagem) · Navegador
(inspeção do painel RADAR).

**Na manga:** Cloudflare (R2 / Workers) · Serviço de e-mail (alerta ativo) ·
Artifact (hospedagem privada alternativa).

**Irrelevantes:** Canva, Expo/EAS, Supermetrics, Notion, Gmail, Calendar,
ElevenLabs, agendamento de redes sociais.

---

## 13. Riscos conhecidos

| # | Risco | Mitigação |
|---|---|---|
| R2 | **A `anon key` fica visível no HTML.** | Normal e esperado — mas a segurança inteira depende de **RLS bem configurada**: leitura pública nas tabelas de previsão, escrita restrita e protegida contra abuso no botão de reporte. "Amigo confiável" **não** substitui RLS. |
| R3 | **Open-Meteo é gratuito para uso não comercial**, com limite de requisições. | Volume estimado (120 pontos × 4 modelos × poucas vezes/dia) deve caber. Coletar no servidor, nunca no navegador de cada usuário. |
| R6 | **Dados da ANEEL têm atualização mensal** — inúteis para verificação em tempo real. | São para **treino**, não para verificação corrente. Papéis distintos. |
| **R10** | ⚠️ **A verificação do impacto é retrospectiva, não corrente.** ✅ **Mitigado em 2026-09-11:** `tempo.impacto_previsto` congela diariamente o que o painel previu, e `tempo.impacto_pontuar()` produz Brier e confiabilidade por antecedência quando o lote da ANEEL chega. Ver §10.1. | O que **não** é resolvível: a aferição sempre chega semanas depois, porque a fonte publica em lote. Limite da fonte, não do desenho. O painel declara quando um número ainda não foi verificado. |
| **R11** | ⚠️ **Permissão de leitura tem DOIS mecanismos, e o `anon` precisa dos dois.** Três ocorrências em 2026-09-11: (1) `DROP VIEW` apagou o grant de `tempo.risco_energia` e o cartão sumiu com 401; (2) `tempo.clima_normal` tinha RLS sem policy e o LEFT JOIN devolveu **nulo em silêncio**; (3) `tempo.risco_snapshot` ganhou policy mas não grant → 401. | Para tabela nova lida pelo painel, as três linhas juntas: `enable row level security` + `create policy leitura_publica ... to anon` + **`grant select ... to anon`**. Ao recriar view em `tempo.`, repor o grant na mesma migration. |
| **R12** | ⚠️ **View `security_invoker` + tabela com RLS sem policy = coluna nula em silêncio.** `public.tempo_previsao_dia` juntava `tempo.clima_normal` diretamente; o `anon` via zero linhas e o LEFT JOIN devolvia nulo, sem erro. | Padrão do projeto: a view **interna** faz o trabalho (roda com direitos do dono) e a pública é casca fina. Join em tabela de referência vai para dentro. |
| **R8** | ⚠️ **O schema das ferramentas MCP pode degradar ao retomar uma sessão.** Confirmado em 2026-09-11: `deploy_edge_function` e `deploy_to_vercel` passaram a receber `{"type":"object"}` sem propriedades, e qualquer parâmetro que não seja texto (array, booleano) chega convertido em string e é rejeitado por validação. O conector reportava-se **saudável** (29 ferramentas) e o `reconnect` recusou justamente por isso. Compactar a sessão **não** recarrega schema. | **Sessão nova.** Diagnóstico rápido: um deploy de 40 bytes falha igual — se falhar, não é tamanho de payload, é schema. Ferramentas só com parâmetros de texto (`execute_sql`, `apply_migration`) seguem funcionando, então dá para trabalhar no banco normalmente. |
| **R13** | ⚠️ **Atualizado em 2026-10-15: banco a 334 MB, e com retenção de 90 dias a `verificacao` levaria o total a ~515 MB por volta de 08/12 — acima do limite, e banco acima do limite no plano gratuito fica somente leitura.** Mitigado pela migration 084: retenção da `verificacao` de 90 → 45 dias, regime projetado em ~410 MB. Medido antes: na janela de 45 dias os 256 grupos de skill passam no portão (mínimo de 356 horas distintas contra 72). Medir de novo quando a retenção de 45 dias estabilizar (~fim de outubro) e quando o PregadorAPP crescer. Texto original abaixo. — **O schema `tempo` cresceu além da projeção: 132 MB contra os ~71 MB previstos na §6**, e o banco compartilhado está em **302 MB de ~500** (medido em 2026-10-01, já com a verificação de horizonte longo). `tempo.previsao` custa 98 MB (a retenção de 10 dias funciona; o que errou foi o custo por linha) e `tempo.verificacao` 24 MB com 201 mil linhas — crescendo ~11 mil/dia contra retenção de 90 dias, ou seja, rumo a ~1 milhão de linhas e ~120 MB em regime. | Ainda cabe, mas a folga encolheu e o orçamento é **compartilhado com o PregadorAPP**. Medir de novo quando a `verificacao` atingir o regime de 90 dias (por volta de 2026-12). Alavancas, na ordem: encurtar a retenção da previsão de 10 para 7 dias (−30 MB), agregar `verificacao` antiga em resumo por grupo em vez de guardar par a par, e só então o armazenamento frio no Cloudflare R2 (§12). |

---

### Riscos encerrados

Saíram da tabela acima em 2026-09-28 por estarem resolvidos — ficam registrados
porque o motivo do encerramento é informação, e porque a numeração R8–R13 se
apoia neles.

| # | Risco | Desfecho |
|---|---|---|
| R1 | Projetos free do Supabase pausam por inatividade (~7 dias) | ✅ **Não ocorre.** Verificado na prática: o projeto roda sem interrupção desde 2026-09-10, com `pg_cron` de hora em hora e 204 mil verificações acumuladas. Nenhuma pausa, nenhum buraco na série. |
| R4 | `file://` envia `Origin: null` | ✅ **Resolvido** pela hospedagem na Vercel, aceita pelo usuário em 2026-09-10. |
| R5 | RADAR pode ser Power BI fechado, sem consumo legítimo | ✅ **Confirmado e absorvido** (D1, §8.3): é Power BI sem API e sequer publicado. O histórico mensal da ANEEL assumiu o papel de ground truth, e o painel linka o RADAR como consulta manual. |
| R9 | Segredo compartilhado em texto claro no fonte das Edge Functions | ✅ **Resolvido em 2026-10-02.** Saiu do código dos dois coletores e passou a vir de `Deno.env.get("TEMPO_SEGREDO")`, com o valor num secret do Supabase. Foi **rotacionado**, não só movido: a criação do repositório em 02/10 pôs o valor antigo no histórico do git, e histórico não se apaga — remover não bastaria. |
| R7 | Limite de 2 projetos ativos no plano free do Supabase | ✅ **Contornado** (D4): o TEMPO vive no schema `tempo` dentro do `PregadorAPP`, com `legno-lp` intocado. A premissa "coisas separadas" foi preservada por isolamento de schema, não de projeto. |

---

## 14. Decisões pendentes

| # | Questão | Status |
|---|---|---|
| D1 | Inspecionar o painel RADAR | ✅ **Resolvida** (2026-09-10) — não é utilizável, ver §8.3 |
| D2 | Alerta ativo por e-mail | ✅ **Resolvida** (2026-09-10) — **não agora**; gatilho construído e **desarmado** (`tempo.gatilho_alerta.ativo = false`) |
| D3 | Nome e região do projeto Supabase | ✅ **Resolvida** — `tempo-rj`, `sa-east-1` |
| D4 | Como liberar o 3º slot de projeto no Supabase | ✅ **Resolvida** — schema `tempo` dentro do `PregadorAPP`, `legno-lp` intocado |
| D5 | Desligar a proteção de login da Vercel | ✅ **Resolvida em 2026-09-10.** O token do MCP nunca teve escopo para isso (403 persistente em 3 tentativas); feito pela UI, via automação do Chrome do usuário, a pedido dele. Site verificado público: `200 · text/html · 18.850 bytes`. |
| **D7** | **CEMADEN — resolvida em 2026-09-11.** A conclusão anterior estava errada: `311_24.json` não é fatia arbitrária de mapa, é a **camada de pluviômetros automáticos** (nacional, com `estacao_uf`). E há endpoint melhor: `getJson2.php?uf=RJ`, JSON plano por UF, com janelas de 1h a 96h. Em produção: 64 municípios observados, 8 regiões verificadas. Ver §8.2. | ✅ **Resolvida** |
| D8 | Histórico ERA5 × interrupções para treinar a camada 3 | ✅ **Resolvida em 2026-09-11** — ver §9.1 |
| **D11** | **Driver de raio: CAPE.** ✅ **Resolvida em 2026-09-11** — CAPE entra como **terceiro driver**, não como substituto. Ver §9.6. | ✅ **Resolvida** |
| **D10** | **Clientes sem energia, não chamados.** O dataset *Interrupções de Energia Elétrica nas Redes de Distribuição* (~270 MB/ano) traz **unidades consumidoras afetadas** por interrupção — que é o número que o usuário instintivamente procura ("1.822 clientes sem energia"). Seria a métrica de impacto de verdade. | 🟡 **Aberta** |
| **D9** | **Ampliar a amostra da camada 3.** ✅ **Resolvida em 2026-09-11** — recalibrado com 2023+2024+2025+2026, **123.648 município-dia** contra 33.580. A faixa ≥70 km/h foi de **68 para 177 dias**. Ver §9.5. | ✅ **Resolvida** |
| D6 | Achado de segurança **no PregadorAPP** (não é do TEMPO): `public.rls_auto_enable()` e `public.handle_new_user()` são `SECURITY DEFINER` e chamáveis pelo `anon` via `/rest/v1/rpc/`. Também há 2 tabelas com RLS sem policy e proteção de senha vazada desligada. | ⚠️ **Reportado, não corrigido** — é o outro projeto, decisão do usuário |

---

## 15. Registro de decisões tomadas

| Data | Decisão |
|---|---|
| 2026-11-15 | **Modelo de impacto recalibrado com setembro/2026** (pedido do usuário: "Pode recalibrar o modelo com setembro"; `sql/104`, reversão em `sql/104_reverter_calibracao_set11.sql`). 2023 a 30/09/2026, **125.948 município-dia** (antes 123.648). **Defeito corrigido junto:** dia com tempo baixado e sem ANEEL entrava como "zero chamados" (dia calmo falso); em 11/09 eram 5 dias (01 a 05/09/2026), e com o tempo até novembro seriam ~40. `2_montar_painel.py` agora corta cada ano no último mês com volume normal da ANEEL. **Comparação** (produção de 11/09 → só até agosto com a correção → com setembro): rajada ≥70 km/h +0,586 → +0,682 → **+0,669**; 60–70 +0,305 → +0,367 → **+0,350**; chuva ≥12 mm/h +0,309 → +0,370 → **+0,376**; chuva 1–3 +0,162 → +0,185 → **+0,155**; CAPE ≥2k +0,180 → +0,193 → **+0,195**. A maior parte da mudança veio da correção e do arquivo de 2026 revisado pela ANEEL; setembro (mês seco) acalmou um pouco vento e chuva fraca. **Conferências:** viés +0,04; MAE 8,69 (só base 9,09); alcance 31 → **38 de 92** municípios atingem o próprio p95 (teto 94% do p95); curva de probabilidade monotônica, 4,0% a **31,4%** (antes 33,8%); limiar de dia ruim 2,19 → **2,18**. A base por município (nível de 2025) não mudou. A verificação de setembro não se alterou (skill ~0); ela mede as previsões congeladas, feitas com o modelo antigo. O rodapé do painel passou a "tudo incorporado". |
| 2026-11-15 | **Robô da ANEEL no GitHub apagado; carga manual; aviso no rodapé** (pedidos do usuário: "Pode excluir o robô do GitHub, porque se não funciona, melhor apagar" e "colocar um aviso no rodapé que existem dados disponíveis não baixados e incorporados ao modelo"). O robô (`.github/workflows/aneel.yml`) falhava todo dia desde 11/11: o site da ANEEL derruba as conexões das máquinas do GitHub, e daqui baixa na hora. A carga passa a ser manual, com `calibracao/8_sincronizar_aneel.py`, que agora grava em `tempo.aneel_arquivo` até que mês a ANEEL publicou (`sql/103`). Saiu da saúde a linha "Robô da ANEEL", que ficaria vermelha para sempre. **Rodapé do painel** (`tempo_aneel_situacao`): diz até quando a ANEEL publicou, até quando as previsões de impacto foram conferidas e quais aguardam publicação; quando há dado publicado e não incorporado, mostra o aviso em amarelo, separando "não baixado para conferir" de "não incorporado à calibração". **Situação em 15/11:** ANEEL até set/2026 (arquivo de 12/11); conferido até 30/09; calibração do impacto até 31/08, então **setembro está disponível e fora da calibração**; previsões de 01/10 a 19/11 aguardam a ANEEL (outubro deve sair em meados de dezembro). Os secrets `TEMPO_ANON_KEY` e `TEMPO_INGESTAO_SEGREDO` continuam cadastrados no GitHub, sem uso. |
| 2026-11-16 | **Repositório pronto para ficar público, painel fora do Google, publicação pelo GitHub** (pedidos do usuário: "Podemos colocar público no github?", "para não ser indexado e achado pelo google"). Varredura do histórico: nenhum segredo (token, chave REDEMET, segredo de ingestão, service_role) nem chat_id. O e-mail pessoal de autor foi trocado pelo noreply do GitHub nos 80 commits (reescrita + push forçado feito pelo usuário) e o branch velho `main-m2wte5` apagado; os commits dos PRs #1 e #2 continuam guardados pelo GitHub com o e-mail antigo. Painel com `noindex` (meta + cabeçalho). A primeira publicação automática saiu sem Root Directory e deu 404 na raiz; corrigido para `web`. |
| 2026-11-16 | **Falha da REDEMET deixa de ser silenciosa; `/ouvi` vira verdade de campo** (usuário ouviu trovoada em São Pedro da Aldeia sem aviso; "As duas"). Diagnóstico: a REDEMET ficou 1h43 sem publicar quadros (12:40→14:23 BRT); o coletor respondia "ok", o boletim das 14:34 saiu sem trovoada; quando o dado voltou, a célula estava a 26 km (faixa 20-30\|1-4, chance 21% < corte de 40%) e o aviso da Região dos Lagos saiu às 14:37 sem citar a cidade. Mudanças (`sql/106`): (1) coletor acusa problema quando o quadro mais novo passa de 30 min (vai para `tempo_saude`); `tempo_tg_redemet_situacao()` faz o bot mandar UM aviso ao administrador quando a REDEMET cai e outro quando volta; o boletim mostra "sem leitura da REDEMET desde HHhMM". (2) `/ouvi <município>` grava em `tempo.trovoada_relato` o relato e o que o sistema via (distância mínima nos últimos 30 min, faixa, chance, aviso); `tempo.trovoada_relato_resumo` agrupa por distância. **Não mexe na chance** (que mede "chegou a 10 km"): com 2 pessoas relatando, a amostra é pequena e enviesada; serve para decidir com número se o corte deve cair para trovoada audível. Primeiro relato carregado à mão (16/11 14:34, 26 km). O bot publicado é a versão compactada (esbuild, sem comentários) de `functions/telegram/*.ts`, para caber na publicação pelo conector. |
| 2026-11-16 | **Aviso de trovoada: atualização marcada, energia dentro do mesmo card, espera de 40 min** (pedidos do usuário: "40min"; "colocar uma TAG de atualização de status da região, daí não fica parecendo aviso repetido"; "o aviso de falta de energia precisa vir junto com o anterior, porque entrando um após o outro as leituras se perdem"). (1) Município novo numa região já avisada sai depois de 40 min, não 2 h (`sql/107`, parâmetro `trovoada_param.espera_novo_min`). (2) `tempo_tg_plano_trovoada` passa `atualizacao`, `anterior` e `novos` (`sql/108`); o card ganha a etiqueta "ATUALIZAÇÃO · aviso das HHhMM" no topo e "NOVO ·" em cada município que entrou; a legenda começa com 🔄. (3) O card separado "Risco de falta de energia agora" (de 08/11) deixa de existir: o risco vira uma seção do próprio aviso de trovoada, e o "O que fazer" junta as duas recomendações. |
| 2026-11-16 | **"Informar evento" substitui o /ouvi** (pedido do usuário: "Troque \ouvi por \Informar Evento... opção de marcar mais de um evento... a região toda ou municípios da região"; leitura combinada: "se o bot avisou entra como confirmação, se não avisou entra como alerta para análise"). Comando `/evento` (o Telegram não aceita espaço nem maiúscula; no menu aparece "Informar evento"); `/ouvi` virou atalho com Trovoada marcada. Três telas na mesma mensagem, editada a cada toque: eventos (vários: trovoada, chuva forte, vento forte, granizo, alagamento, falta de luz) → região → região toda ou municípios (vários). As marcações viajam no próprio botão (máscaras de bits; `callback_data` tem 64 bytes). `sql/109`: `tempo.evento_relato` (uma linha por evento × município) e `tempo_tg_evento()`, que só conta como **confirmação** o aviso que **chegou ao celular** (trovoada enviada nas 2 h anteriores; INMET laranja/vermelho enviado; chuva forte medida enviada; Defesa Civil hidrológico; risco elétrico elevado/alto do boletim; rajada ≥ 60 km/h no boletim); o resto vai para **análise** com o que o sistema via (ex.: "o corte de 40% segurou o aviso"). Administrador recebe na hora os casos de análise de outras pessoas. Filas: `tempo.evento_resumo` e `tempo.evento_analise`. O relato do /ouvi de 14:34 foi copiado. |
| 2026-11-24 | **Quarentena de pluviômetro** (pedido do usuário: "Pode fazer as duas"; `sql/117`). Toda segunda, `tempo.qc_pedir()` (09h30 UTC) pede ao Open-Meteo, via pg_net e sem custo, a chuva horária do ERA5 e da análise do ECMWF IFS para 28 dias, terminando 7 dias atrás. `tempo.qc_avaliar()` (09h40 UTC) compara, nas mesmas horas, o medido (média das estações) com as duas referências e com os vizinhos a até 40 km. **Baixo:** medido < 35% do menor entre ERA5 e IFS (com ≥ 30 mm na referência) e < 40% da razão mediana dos vizinhos. **Alto:** medido > 2,2× o maior (com ≥ 60 mm medidos) e > 2× os vizinhos. Janela seca ou cobertura < 60% das horas não decide nada. Os vizinhos entram porque o ERA5 também erra, sobretudo na serra. A quarentena esconde as horas do pluviômetro em `tempo.obs_horaria` (a original virou `obs_horaria_bruta`, que só a avaliação lê). Com isso, ele sai da verificação nova, do aviso de chuva forte, do boletim e do card do município ("sem pluviômetro com leitura"), e o risco elétrico do dia (`drivers_dia`) usa a chuva prevista. Os pares antigos ficam no banco e são filtrados em `atualizar_skill` e `atualizar_calibracao`: é reversível, e um "ok" posterior encerra a quarentena. Histórico em `tempo.pluviometro_avaliacao`. **Primeira avaliação (11/09-18/11):** 5 em quarentena, todos "baixo": Mendes (0 mm contra 417/433), Areal (70 contra 597/418), Três Rios (40 contra 364/409), São Sebastião do Alto (68 contra 430/375) e Santa Maria Madalena (124 contra 436/415). 55 ok e 12 sem teste por cobertura curta, entre eles os 3 "altos" do estudo (Levy Gasparian, Paty do Alferes, Queimados), Carmo e Japeri. Calibração refeita: k6 26,3 → 28,6%; k7 37,8 → 41,2%; k8 45,4 → 49,8%. Pesos: mudança máxima de 0,056. |
| 2026-11-24 | **Estudo: ERA5 (Open-Meteo) contra os pluviômetros** (pedido do usuário: "Pode estudar o ERA5 pelo Open-Meteo", depois do artigo sobre o ERA6). Já usávamos o ERA5 para a normal 1991-2020 (`clima_normal`) e para treinar o modelo de impacto (§9). O teste comparou a chuva horária do ERA5 e da análise do ECMWF IFS (9 km, mesma API) com a média das estações do CEMADEN, de 11/09 a 18/11, em 72 municípios. Download pelo próprio banco (pg_net), em tabela temporária, apagada no fim. O ERA5 chega com cerca de 6 dias de atraso e o ERA5-Land veio vazio. **Hora a hora** a reanálise não serve: correlação 0,20 (ERA5) e 0,21 (IFS); marca chuva em 15% das horas contra 8% medidas, com 71% de alarme falso. Nas 185 horas com alguma estação ≥ 20 mm, dava 1,6 mm em média e ≥ 5 mm em só 10% delas. Ainda assim fica acima das nossas previsões de 0-6 h nas mesmas horas (0,10 a 0,16). **Dia a dia** melhora: correlação 0,57 (ERA5) e 0,63 (IFS); 66% dos dias com ≥ 10 mm detectados, metade de alarme falso. **Total do período:** o ERA5 dá 24% a mais que os pluviômetros (mediana por município, faixa central 1,03-1,59, já sem os suspeitos). Isso indica que a normal do ERA5 pode estar alta e o "% do previsto para o mês" do painel e do bot, baixo; falta confirmar com a normal do INMET. **Achado principal: o ERA5 denuncia pluviômetro com defeito.** Mendes marcou 0 mm em 1.608 horas, contra 417 mm do ERA5, 433 mm do IFS e 313-513 mm nos vizinhos (Vassouras, Barra do Piraí, Miguel Pereira, Piraí). Pela regra "medido < 35% do menor entre ERA5 e IFS, ou > 2,2× o maior", são 13 suspeitos: 10 abaixo (Mendes, Carmo, Japeri, Areal, Três Rios, São Sebastião do Alto, Cantagalo, Santa Maria Madalena, Sumidouro, São Fidélis) e 3 acima (Comendador Levy Gasparian, Paty do Alferes, Queimados). Fora eles, a chance de chuva aprendida sobe: com 6 de 8 famílias prevendo chuva, 26,3% → 29,7%; com 7, 37,8% → 43,4%; com 8, 45,4% → 51,8%. Nada mudou no sistema; os próximos passos aguardam decisão do usuário. |
| 2026-11-24 | **Alerta Rio desligado** (pedido do usuário: "cancelar a validação do Alerta Rio, pois se não temos dados desde 22/10, não faz sentido ficar buscando"; `sql/116`, `tempo-coletar-observacao` v13, `tempo-telegram` v20). A fonte devolvia a página HTML do firewall da prefeitura desde 22/10 ~21h UTC: 730 rodadas seguidas com falha. Ela não pesava no modelo (sem dado novo, a preferência por `alerta-rio` em `obs_horaria`, `verificar`, boletim e avisos não escolhia nada; o Rio já vinha só pelo CEMADEN). O dano era outro: toda rodada do coletor de observação ficava `ok = false`, e um erro de verdade do INMET ou da Defesa Civil se escondia no meio. Primeira rodada sem falha desde 22/10: 24/11 13h55 UTC. Também: a linha "Chuva medida (Alerta Rio)" saiu de `tempo_saude` (sem isso ela passaria a aparecer em dia, porque o monitor media a fonte pela ausência do texto `alertario` no erro), e os rodapés do bot deixaram de citar o Alerta Rio como origem. Ficam, de propósito: os 19.376 pares de verificação do Alerta Rio até 22/10 (medição real, já pela média, 2,7% dos pares) e as 63 mil leituras em `observacao`. Para religar, recuperar o bloco do coletor no git. |
| 2026-11-22 | **Céu e tempestade do painel passam a ser aprendidos com observação** (usuário: "sol, tempestade e noite limpa nunca aparecem", céu azul em São Pedro da Aldeia; "Pode fazer"). Diagnóstico: a mediana da nuvem TOTAL dava 81-96% com METAR FEW em todos os aeroportos do RJ — ECMWF, GFS, ARPEGE e JMA punham 77-100% de nuvem ALTA (cirro fino) e 0-20% de baixa+média; nos 5 dias seguintes nenhuma hora do estado ficava abaixo de 40%. A tempestade exigia chance de chuva forte ≥ 50% ou mediana ≥ 15 mm/h; o máximo do estado era 24% e 7 mm/h. Mudanças: (1) o coletor busca nuvem baixa e média e grava só o máximo das duas (`nuvem_vis`; o banco está em ~460 de 500 MB); (2) `sql/110`: METAR de 9 aeroportos do RJ de hora em hora (`tempo.nuvem_obs`, via pg_net, REDEMET) pareado com a previsão da mesma hora; `tempo.trovoada_par` pareia, para os 92 municípios, energia para tempestade × chance de chuva com célula da REDEMET a até 10 km; `tempo.ceu_calibrar()` (diário) aprende os cortes do céu por quantis (a previsão passa a ter a mesma frequência de cada categoria que o céu observado; provisórios 20/50/85% até 200 pares) e a chance de trovoada por faixa (frequência observada encolhida para uma chance inicial, peso 30); (3) `tempo_previsao` entrega `ceu`, `p_trovoada` e `trovoada` prontos; o painel só desenha. Conferência: `tempo.ceu_desempenho`. |
| 2026-11-22 | **Retenção revista e verificação que cobre a faixa inteira** (pedidos do usuário: "Revise a retenção da verificação e das previsões"; "corrige a verificação também"). O projeto Supabase é o **PregadorAPP** (do Lumen); o TEMPO-RJ é hóspede no schema `tempo` e os dois dividem 500 MB. (1) `tempo.previsao` 10 → **7 dias** (`sql/111`): nada lê previsão com mais de 6 dias. (2) `verificar()`: cada faixa de antecedência, nos 8 pontos-sentinela, passa a ser representada pela emissão mais perto do **centro** (48 h e 96 h; 0-6h e 6-24h seguem com a mais recente, como nos demais pontos — com centro também em 6-24h a mesma hora ganhava dois pares, visto e corrigido na rodada de 15:25, 56 duplicatas apagadas), não pela mais recente — antes 6-24h media ~10 h, 24-72h ~28 h e 72-120h ~76 h, e na semana até 22/11 não houve par com 48-71 h nem com 96-120 h; a leitura de previsões passa de 4 para 6 dias (rotina de 28 → 43 s). Transição: por 45 dias os grupos 24-72h e 72-120h misturam os dois critérios. (3) `tempo.verificacao` segue com 45 dias (é a memória dos pesos). Manutenção única: `vacuum full tempo.previsao`, `reindex table tempo.verificacao`, `vacuum full net._http_response` (46 MB de respostas HTTP já apagadas). **Banco: 459 → 345 MB.** |
| 2026-11-22 | **Chuva observada por município: mediana → média das estações** ("estuda antes de trocar a mediana" → "Pode trocar"; `sql/113`). Motivo: Petrópolis 22/11 17h, 26,6 mm numa estação e mediana das 17 = 0. Estudo (CEMADEN 11/09-22/11, 72 municípios): com 10+ estações a mediana dava "não choveu" em 50% das horas com alguma estação ≥ 10 mm (58% com ≥ 20 mm); a ordem dos modelos não muda (MAE no 3º decimal); a chance aprendida saía metade da real nas cidades grandes (6 de 8 famílias: 23% pela mediana × 44% pela média). Média e não a estação mais molhada: é a grandeza que o modelo prevê (média de área) e não depende de quantas estações o município tem. `obs_horaria` passa à média (CEMADEN e Alerta Rio) e ganha `observado_max`; os 45 dias de `verificacao` foram recalculados e pesos/calibração refeitos na hora. Calibração (frequência observada por nº de famílias prevendo chuva): k4 14,2 → 16,6%; k6 23,6 → 26,3%; k8 41,5 → 45,4%. Pesos: mesma ordem, viés do ICON 0,027 → −0,001. Efeito colateral: o aviso de chuva forte medida (≥ 30 mm/h) lia a mediana e passa a ler a média — **não** lia a estação mais molhada, como eu tinha dito. |
| 2026-11-22 | **"Informar evento": trovoada vira OUVI TROVÃO e VI CLARÕES** (pedido do usuário: "Pode separar em vi clarões e ouvi trovão"; `sql/114`). Motivo: em São Pedro da Aldeia, 22/11 19h49, clarões sem som com a célula a 41 km (painel "por perto"); em 16/11, trovão ouvido com a célula a 26 km — ver e ouvir dizem distâncias diferentes. Trovão: confirmação só com aviso de trovoada enviado. Clarão: confirmação também quando o sistema via trovoada a até 50 km (painel), porque trovoada distante não gera aviso. Relatos reclassificados: 16/11 → trovão, 22/11 19h49 → clarão; 22/11 18h30 em Petrópolis ("raios e relâmpagos") fica como `trovoada` (antigo, ambíguo). Bot: 7 eventos, o último sozinho na linha; `/ouvi` continua marcando o trovão. |
| 2026-11-22 | **Aviso de chuva forte medida: 1 hora pela estação mais molhada** (pedido do usuário: "Pode usar a estação mais molhada no aviso de chuva forte"; `sql/115`). O critério de 30 mm/h passa a ler `obs_horaria.observado_max`; o de 50 mm/24 h segue pela média (somar a mais molhada de cada hora juntaria estações diferentes). Teste no histórico CEMADEN 11/09-22/11: município-dia com aviso 30 → 66, dias com algum aviso no estado 21 → 29 (de 73); Angra dos Reis seria o mais frequente (7 dias). Em 22/11 a regra nova teria avisado Barra do Piraí (31 mm numa estação, 16 mm de média); Petrópolis (26,6) e Teresópolis (28,2) seguem abaixo do corte. O bloqueio de 6 h por município continua. |
| 2026-11-13 | **Bot passa a mandar tudo em IMAGEM** (pedido do usuário: "facilitar a leitura... a imagem dá para copiar e compartilhar"; aprovado depois de um teste com os 11 tipos: "Ficaram bons... Ficou muito bom"). `functions/telegram/cards.ts` monta o card (satori → SVG → resvg → PNG, WebAssembly, fonte Inter do jsDelivr, custo zero); cores do painel; faixa colorida = gravidade, ícone = assunto; escala de nível no INMET, na Defesa Civil e no risco elétrico; "O que fazer" em caixa destacada; rodapé com origem e tempo-rj.vercel.app, para quem receber a imagem compartilhada saber de onde veio. **Enriquecimento pedido ("sem poluir"):** tabela município a município no boletim da região (maior de cada coluna em negrito), próximos 3 dias no do município (com os 8 quadradinhos das famílias; `sql/102`, `tempo_tg_dias`), porte da tempestade na trovoada (célula isolada / grupo / tempestade organizada) e as duas medidas na chuva forte. **Mecânica:** cada mensagem vira um trabalho (card + legenda curta + texto de reserva + destinatários); a imagem é desenhada uma vez e reaproveitada (file_id) para todos; no máximo 2 imagens por execução (limite de CPU do Supabase), o resto da fila segue em `?acao=fila`, em ordem; se a imagem falhar, sai o texto de antes. Um toque por rodada por pessoa. Teste: boletim das 11 regiões em 15 s, todas como imagem. `?acao=teste_cards` manda os 9 exemplos só para o administrador. |
| 2026-11-13 | **Aviso de trovoada refeito, com aprendizado** (aprovado pelo usuário: "Pode. Porém deveria ter uma lógica de aprendizado por trás"; `sql/101`, coletor v4, bot v13). **Regra:** "próxima" = trovoada a 10-30 km nos últimos 20 min, sem exigir aproximação e sem horário de chegada; "sobre a cidade" segue igual (≤10 km). **Aprendizado:** cada início de episódio por município vira uma linha em `tempo.trovoada_aviso` (enviado ou não), com distância, células a até 50 km e aproximação. 2 h depois o próprio banco confere se chegou descarga a até 10 km (`trovoada_verificar`, chamada a cada coleta). A chance mostrada é a da faixa (distância 10-20/20-30 × células 1-4/5-14/15+): (acertos + 30 × prior) / (conferidos + 30), só com os últimos 90 dias. O prior vem do backtest (`trovoada_prior`: 41% a 75%). Faixa cuja chance cair abaixo de 40% (`trovoada_param.limiar_chance`) para de ser avisada, mas continua registrada e conferida para poder voltar. Os quadros do STSC ficam guardados 180 dias (`trovoada_quadro`), para testar regras futuras com dado real. Consulta: `public.tempo_trovoada_desempenho`. **Volume:** município novo "próximo" só reabre mensagem da região 2 h depois da última; município novo "sobre a cidade" sai em até 20 min. **Mensagem:** cada município com a distância, o lado e "X% de chance de chegar"; o rodapé diz a taxa medida quando houver 20 avisos conferidos. |
| 2026-11-13 | **"Trovoada a caminho" falha no nível de município — diagnóstico (D17, `16_aviso_trovoada_municipio.py`), correção aguardando o usuário.** Caso: São Pedro da Aldeia, 13/11. O bot avisou "a caminho, chega 14h57" às 13h07, e a trovoada nunca passou de 32 km. **Os dados estavam certos:** as células do STSC ficaram na serra (Silva Jardim/Casimiro de Abreu, 30-45 km), Casimiro mediu 30 mm às 14h, e os METAR de SBES (São Pedro) e SBCB (Cabo Frio) não registraram trovoada nem chuva a tarde toda, só TCU no horizonte. **Os modelos também acertaram:** 0,3 mm previstos para São Pedro (2 de 8 famílias), com CAPE de 3.680, o perfil de tempestade isolada. **O defeito é a regra do aviso:** ela compara a célula mais próxima agora com a mais próxima há 30 min, e numa tarde de verão uma célula NOVA nascendo mais perto vira "aproximação" sem nada ter andado. Ao vivo (07-13/11), só 26 de 164 avisos (16%) tiveram célula a até 10 km do município em 2 h. No histórico (34 dias, 92 municípios): a regra no ar acerta 38% por município, contra 31% de "há célula a até 50 km" e 50% de "há célula a até 30 km" (que cobre 81% das chegadas, com 54 min de antecedência). Ou seja, a aproximação quase não acrescenta, e o horário de chegada é precisão falsa. O D15 tinha medido o acerto por região (3 de 4), que é bem mais folgado do que o que a mensagem afirma. **Volume:** em 13/11, até as 17h, o assinante "Todas" recebeu 60 mensagens de trovoada/risco e a assinante Lagos+Serrana recebeu 21. |
| 2026-11-13 | **Ventania medida nos aeroportos: inconclusivo, não adotada** (D16, `15_testar_ventania.py`). Ideia do usuário depois de 07/11: se um aeroporto a até 100 km mede rajada forte junto com tempestade, o "trovoada a caminho" daquele município deveria pesar mais. **Conserto do download:** a REDEMET devolve no máximo 150 METAR por pedido e corta o resto sem avisar (sem página 2; `page_tam` acima de 150 volta vazio). O script agora parte a janela ao meio até caber. **Dados:** 32 dias com trovoada (jan-jul), 1.880 episódios "a caminho", 8.352 METAR/SPECI de 15 aeroportos. **Resultado:** rajada ≥30 kt com tempestade ocorreu só **6 vezes em 3 dias**, e só **4 episódios** tiveram ventania a montante. Esses 4 tiveram 5,1× as ocorrências normais da ANEEL nas 3 h seguintes, contra 2,4× nos outros episódios dos mesmos dias. A margem é ±5, então pode ser acaso. A ≥25 kt (12 episódios) a mediana fica **abaixo** do normal. **Leitura:** os aeroportos medem rajada de tempestade raramente demais para sustentar um aviso; o sinal aponta na direção certa, mas com 4 casos não se decide nada. Base de comparação: o "a caminho" sozinho já dá 1,29× o normal. Reavaliar quando houver um verão inteiro de STSC (jan-mar/2027). |
| 2026-11-08 | **Bot do Telegram (@TempoRJ_bot) implementado e no ar** (migrations 089-098, `functions/telegram`). **Cadastro:** o primeiro a dar /start virou administrador. Os demais ficam pendentes até o administrador tocar em Aprovar. Escolha de regiões por botões (11 ou "Todas"), /regioes, /parar e /ajuda. O endereço do painel fica fixado no topo da conversa e no perfil do bot; os avisos trazem o essencial, e o site serve só para quem quiser ver mais. **Boletim** às 06h, 12h, 18h e 00h (este sem som), um card por região em mensagens separadas, e só o primeiro toca. O formato é o do modelo aprovado pelo usuário: o primeiro envio, compacto e não aprovado, foi reprovado ("tudo embolado"). Os números são os do painel, do município mais crítico da região, com chance "de virar chuva realmente" e "% do previsto para o mês" (normal 1991-2020). Chuva medida: Alerta Rio antes do CEMADEN. **/boletim** abre "📍 Um município" (região → município, ou "/boletim Petrópolis") ou "🗺️ Minhas regiões". O card do município é a foto do painel para ele, com trovoada agora e os dois riscos da Defesa Civil em qualquer nível. **Avisos imediatos** a cada 6 min, no modelo O quê · Onde · Quando · O que esperar · O que fazer. São: trovoada a caminho / sobre a cidade / se afastou, com rumo e velocidade; INMET laranja ou vermelho novo, região que entrou e laranja que virou vermelho (o amarelo fica só no boletim); Defesa Civil alto ou muito alto; risco elétrico ALTO de hoje ou amanhã com motivo e "x vezes o normal"; chuva forte medida (≥ 30 mm/h ou ≥ 50 mm/24 h). **Trovoada a caminho ou sobre a cidade dispara também uma segunda mensagem de risco de falta de energia** (pedido do usuário). Memória do que já foi dito no banco: 3 h de silêncio por região, exceto quando piora. Na estreia, os alertas que já estavam valendo foram mandados só ao administrador, para não chegarem como novidade de madrugada. **Erros no caminho:** variável `nivel` com o mesmo nome da coluna (corrigido para `v_nivel`) e boletim estourando o statement timeout (resolvido com CTEs `materialized`, 3,3 s). **Chuva medida:** leitura > 120 mm/h e leitura logo após uma falha são descartadas. Laje do Muriaé marcou 189, 122 e 102 mm/h isolados entre zeros, e Levy Gasparian devolveu 55 mm acumulados numa falha. |
| 2026-11-07 | **Bot do Telegram especificado, ainda não implementado** (decisões do usuário, uma a uma). **Canal:** um bot só, sem canal. Cada pessoa conversa em particular, escolhe regiões entre as 11 do painel ou "Todas" e muda pelo Menu (`/regioes`). WhatsApp descartado: o oficial custa ~R$0,035 por mensagem e quebra a Premissa nº1; o CallMeBot é só uso pessoal; as bibliotecas não oficiais arriscam banimento e exigem servidor ligado. **Três tipos de mensagem:** (1) **boletim** a cada 6 h com os números do painel (famílias e chance calibrada em 6 h, chuva forte, acumulado, rajada e temperatura em 24 h, chuva medida no dia e x normal do mês, risco elétrico, alertas em vigor), mostrando o pior município da região; (2) **aviso imediato**; (3) **perguntas** (`/agora`, `/previsao`, `/energia`). **Avisos imediatos:** ⚡ trovoada a caminho / no município / se afastou (regra do D15); 🟠 INMET laranja ou vermelho novo, ou região que entrou num alerta existente (o amarelo fica no boletim porque sai quase todo dia para os 92); 🏔️ Defesa Civil em alto ou muito alto; 🔌 risco elétrico **alto** previsto para hoje ou amanhã (elevado fica no boletim: em 07/11 foram 54 municípios); 🌧️ chuva forte medida (proposta ≥ 30 mm/h ou ≥ 50 mm/24 h, **a calibrar antes de ligar**). Regras comuns: uma mensagem por região juntando os municípios; 3 h de silêncio por região e tipo, exceto quando piora; aviso que começa ou piora toca a qualquer hora; "encerrado" chega sem som; quem segue "Todas" recebe uma mensagem só por rodada. O que fica guardado da pessoa é só o identificador da conversa e as regiões escolhidas, numa tabela sem acesso do painel. |
| 2026-11-07 | **Aviso "trovoada se aproximando" testado (D15, `13_testar_aviso_trovoada.py` e `14_refinar_aviso_trovoada.py`).** Nasceu do diagnóstico da tempestade de 07/11, que levou ~2 h da Metropolitana aos Lagos. Regra por município, a cada quadro do STSC (6 min): célula a 10-50 km, pelo menos 5 km mais perto do que há ~30 min, a no máximo 90 km/h. O teto existe porque célula nova nascendo perto parecia aproximação de 280 km/h. Medido nos 14 dias mais tempestuosos de jan-mar e em 07/11 (2.922 quadros). **Por município:** pega 64% das chegadas, com antecedência mediana de 112 min, mas 54% dos avisos são falsos (trovoada que se desfaz ou muda de rumo). **Por região, que é como a mensagem sai:** pega 50% das primeiras chegadas, 27% de falsos e 107 min de antecedência, com ~3,4 mensagens por região por dia de tempestade. A região pega menos porque a primeira célula muitas vezes nasce dentro dela, e aí não há o que avisar. Filtros testados: exigir ≥ 5 células a 50 km baixa os falsos para 16% mas a antecedência cai para 71 min; ≥ 15 células zera os falsos mas só pega 12%; exigir 2 quadros seguidos quase não muda nada. Escolha: **a regra-base**. Três de cada quatro mensagens certas, com quase 2 h de antecedência, vale mais do que o silêncio de hoje. Em 07/11 ela teria avisado 73 dos 75 municípios atingidos. |
| 2026-11-07 | **Tempestade de 07/11 não prevista: o diagnóstico.** Pelo RADAR da ANEEL, a linha de tempestade levou de ~21 mil a ~683 mil UCs sem luz (Enel RJ 13%, Light 8%; Belford Roxo 50%, Guapimirim 100%). Pelas células do STSC, passou pela Metropolitana às 18-19 UTC (15-16h) e pelos Lagos às 20-21 UTC (17-18h). **Às 10h o painel congelou uma chance de dia ruim de 7 a 17%** nos municípios atingidos. Não é defeito do cálculo: **a entrada nunca teve o vento**. As 8 linhagens, emitidas às 06 e 12 UTC, previam para a tarde rajada de 13-57 km/h e chuva de 0-7 mm/h. Modelo global de 9-25 km não resolve frente de rajada de linha convectiva. O único sinal foi o **CAPE extremo** (5.000-7.800 J/kg em UKMO, ECMWF e GEM), e ele não serve de gatilho: em 2026 jan-jul, os 76 município-dias com CAPE ≥ 4.000 tiveram em média 1,47× a base, e afinar a faixa ≥ 2k não muda o MAE (9,200 → 9,202). O INMET também errou o momento: às 09h deu laranja só para o Sul Fluminense e a Costa Verde, e estendeu à Metropolitana às 15h47, com a tempestade já em curso. **A brecha que existe é de curtíssimo prazo:** a tempestade levou ~2 h da Metropolitana aos Lagos, e o STSC a mostrou chegando. |
| 2026-11-07 | **Radar do Pico do Couto avaliado e não adotado** (D14, `12_testar_radar.py`). Pergunta: o radar (REDEMET, CAPPI 3 km, PNG 250×250 a ~2 km/px, um quadro a cada 20 min, histórico disponível) preenche os 23 municípios sem pluviômetro do CEMADEN? A régua não foi "o radar acerta?" e sim "acerta mais do que usar o pluviômetro do vizinho?", que já existe e custa zero. Teste: as 150 horas mais chuvosas de 11/09 a 07/11 (9.209 município-hora), cor do radar numa janela de ~10 km em torno do ponto, contra o CEMADEN. A janela que casa é [H, H+1). Detecção de chuva ≥ 1 mm (CSI): radar **0,41** a menos de 80 km, **0,44** entre 80 e 150 km e **0,34** acima de 150 km. O vizinho dá 0,41 a até 15 km, 0,38 a 15-25 km, 0,34 a 25-40 km e 0,29 a 40-60 km. Aplicado aos 23: no **Noroeste e Norte** (Itaocara, Pádua, Miracema, Natividade, Porciúncula etc.) o radar está a mais de 150 km e o vizinho a 6-25 km, então **o vizinho ganha**. No **Sul e Centro-Sul** (Paracambi, Valença, Paulo de Frontin, Quatis) há pluviômetro a 4-18 km e dá empate. Só na **Região dos Lagos** (Cabo Frio, Arraial, Búzios, São Pedro, Rio das Ostras, Silva Jardim; vizinho a 23-44 km) o radar ganha, de 0,29-0,38 para 0,44. Não se adota: o ganho fica em 6 municípios, a escala de cores não é publicada (a posição na rampa foi inferida) e a chuva medida alimenta a verificação, onde um radar de segunda mão contaminaria a tabela de calibração. Técnica e custo não são o obstáculo: R$0, PNG legível em Deno, 1 de 795 quadros truncado na origem. |
| 2026-11-07 | **Trovoada observada reprovada como driver de impacto** (D13, `10_baixar_raio.py` + `11_testar_raio.py`). Fonte: produto STSC da API-REDEMET (DECEA), "ocorrência de trovoada" em grade de 0,05°, um quadro por hora, 2026 jan-jul (5.088 horas, 0 falhas, 27.395 células sobre o RJ). Driver: horas do dia local com célula a até R km do ponto do município. Resultado sobre os mesmos 19.504 município-dia do D12: MAE 9,200 → **9,190** no melhor caso (R = 10 km, **0,1%**); trocar a chuva horária pela trovoada **piora** (9,300 a 9,320). Testado com 10, 15 e 25 km, e nenhum raio muda o quadro. A trovoada tira sinal da chuva (`>=12mm` cai de +0,394 para +0,297 a 0,342) em vez de trazer sinal novo, porque se correlaciona +0,42 a +0,50 com ela. Conclusão: **o substituto (`chuva_h_max`) já capta o que a descarga real traria**. E mesmo que ganhasse, o STSC é observação, não previsão, e só serviria para o "agora". A chave da REDEMET fica fora do repositório (variável `REDEMET_KEY`). |
| 2026-10-24 | **Revertidas as mudanças de 23/10, a pedido do usuário** ("foi feita uma alteração errada, voltar a versão de antes de 23/10"). Feitas fora desta sessão, pelo PR #2 e direto no banco. Revertido: (1) commit `83b2de5` por `git revert` — o repositório inteiro ficou idêntico ao de 17/10 (`234e5c6`); (2) Edge Function `tempo-coletar-previsao` republicada como v11 com o código de 17/10 (prazo de lote 30 s, pausa da 2ª tentativa 15 s), `verify_jwt false`, testada: 736/736 em 8,5 s; (3) view `tempo_saude` de volta à definição da 083 (migration 085). Intocados: o commit de 17/10 (prazo por requisição) e o painel na Vercel, que não teve deploy depois de 15/10. |
| 2026-10-24 | **Atraso da ANEEL diagnosticado: não é nosso, e não é só do nosso conjunto.** O arquivo 2026 de Ocorrências Emergenciais segue o de 10/09 (jan-ago), 44 dias sem atualizar, contra frequência declarada **mensal** e intervalo anterior de 37 dias (04/08 → 10/09). O conjunto **irmão**, Interrupções 2026, também parou: última alteração em 04/09. A ANEEL não parou de publicar — DEC/FEC saiu em 23/10 e o conjunto de ocorrências ganhou um dicionário de dados novo ("até dez/2025") em 19/10 —, o que sugere (inferência, não confirmado) retrabalho nos dados de evento de 2026, que mudaram de layout este ano. O robô está certo: lê o recurso certo, 14 de 14 dias sem falha. Nada se perde: 48 dias de previsão de impacto congelados (11/09 a 28/10) esperam a conferência. Contatos do conjunto: `dadosabertos@aneel.gov.br` (EGDI, mantenedor) e `monitoramento.sfe@aneel.gov.br` (SFE, autor). |
| 2026-10-24 | **O aviso do topo passou a ser só para fonte parada SEM reserva** (migration 086, pergunta do usuário: "não sei a real necessidade"). Com o Alerta Rio bloqueado pelo firewall da prefeitura, o topo dizia "a chuva medida está defasada" — falso: o ponto do Rio seguia verificado pelo CEMADEN hora a hora (1.568 pares em 4 dias, status com 202 estações e medição da hora corrente). Defeito do desenho da 083, que tratava toda fonte parada como grave. Agora `tempo_saude` traz `no_topo` (o Alerta Rio só sobe se o CEMADEN também parar) e `obs` ("o Rio segue medido pelos pluviômetros do CEMADEN"), que aparece no monitor ao lado do laranja. Isso refaz, de outro jeito e com o ok do usuário, parte do que a reversão de 23/10 tinha desfeito: lá mudava-se só o texto; aqui muda-se **o que merece o topo**. |
| 2026-10-24 | **Decisão do usuário: a visão materializada da previsão diária FICA** ("acho que agora está normal"). É a única coisa que mantém as barras diárias abaixo do limite de 3 s do anon. Fica registrado que ela nasceu fora do git (migration `tempo_previsao_dia_materializada`, cron `tempo_previsao_dia_refresh` a cada 10 min) e que a causa de fundo — a view original calcular as 92 cidades antes de filtrar — continua lá. |
| 2026-10-24 | **NÃO revertida, aguardando decisão do usuário: a visão materializada da previsão diária** (migration `tempo_previsao_dia_materializada`, 24/10 23:37 UTC, fora do git). Motivo: a view original `tempo.previsao_diaria` leva **3,3 s** para um único município — acima do limite de 3 s do acesso anônimo. Reverter faria as barras diárias do painel pararem de carregar. Ela é lenta porque calcula as 92 cidades inteiras e só então filtra a pedida. |
| 2026-10-24 | **Contexto que a reversão não apaga: o Alerta Rio está bloqueado por firewall desde 22/10 ~21h UTC** (registrado no commit revertido). Com o texto da 083, o aviso do topo volta a dizer "a chuva medida está defasada" em vez de explicar que o Rio passou a usar só o CEMADEN. Em 24/10 23h: 51 h sem atualizar. |
| 2026-10-15 | **O mapa de calor de chuva também lê a tabela de calibração** (pedido do usuário). As cores **não mudaram**: as nove já eram uma por linha da tabela (0 a 8 de 8 famílias). Mudou o que se diz delas — a legenda mostra, embaixo de cada cor, a chance daquela linha (hoje 1,9% a 66,4%), montada em JS a partir da própria tabela, para acompanhar quando ela muda de madrugada; o detalhe de cada hora começa pela chance. O título do cartão já dizia "Probabilidade de chuva" e a legenda dizia "de 8 preveem chuva" — agora os dois falam a mesma coisa. Com isso **nenhum lugar do painel mostra mais a fração bruta como probabilidade**: topo, barras, tabela de texto e mapa usam o mesmo número para a mesma hora. `pctMedida` ficou sem uso e saiu. |
| 2026-10-15 | **Como publicar o painel a partir de uma sessão do Claude Code** (primeira vez feito daqui). O conector MCP da Vercel desta conta **não tem acesso** à equipe `luis-claudio-lopes-da-cruzs-projects` (403 forbidden). Caminho que funcionou: a CLI da Vercel com o login que já existe na máquina (usuário `luislopescruz`), via `npx -y vercel@64.2.0` — a 64.3.1 estava quebrada no npm, dependendo de um `@vercel/build-utils@14.21.2` não publicado. **Publicar de uma pasta limpa** contendo só `index.html` e `.vercel/project.json`, nunca de `web/` direto: lá mora um `.env.local` de 1.428 bytes que não pode subir. Comando: `vercel deploy --prod --yes`. A saída sugere "promover para produção" — é texto genérico; conferir com `vercel inspect` (`target production`). Verificação: sha256 do `index.html` local igual ao servido, e `/.env.local` em 404. Primeira publicação assim: `dpl_gAppAmfjVZq4C1dUd69ozYq4bZ47`. |
| 2026-10-15 | **"se chover," trocado por "Previsto" no rótulo** (preferência do usuário, depois de ver a opção A na tela): `Previsto ~13,2 mm`. O sentido condicional continua escrito na explicação do cartão ("dizem quanto chove, se chover... o que ele não diz é se vai chover — isso é a chance") e na chance logo abaixo do número. |
| 2026-10-15 | **Os milímetros passaram a dizer "se chover"** (opção A, escolhida pelo usuário em caráter de teste — se não gostar, volta). Medido em 1.744 município-dias: nos dias que choveram o volume bate (10,9 previsto × 10,5 mm medido); nos que ficaram secos o painel dizia 2,4 mm. A média de todos os dias saía 40% acima do medido. O número já era um "se chover", só não dizia. Barras: `se chover, ~13,2 mm`; cartão Acumulado 24 h: "se chover · mediana das linhagens"; explicação reescrita. Em 0,0 mm a condição não aparece. Nenhum número mudou, só o que ele diz. Rejeitada a opção B (volume × chance): correta na média, mas nunca bate com um dia real, que ou chove ~4,5 ou não chove. |
| 2026-10-15 | **Retenção da `verificacao` de 90 para 45 dias** (migration 084). A taxa medida (2,7 MB/dia, contra os 2,0 que eu tinha estimado em 05/10) punha o banco acima de 500 MB por volta de 08/12. Com 45 dias, regime em ~410 MB. Custo: calibração e skill passam a refletir ~6 semanas em vez de ~3 meses — menos memória sazonal, resposta mais rápida. Os pesos não sofrem: mínimo de 356 horas distintas por grupo contra 72 exigidas. Como os dados começam em 11/09, a primeira remoção só ocorre por volta de 26/10; até lá, reverter é trocar um número. |
| 2026-10-15 | **Saúde das fontes no painel — no topo quando atrasa, no monitor sempre.** O bug do INMET passou 4 dias sem ninguém ver porque o `coleta_log` não aparecia em lugar nenhum. View `tempo_saude` (migration 083) mede cada fonte pelo **último sucesso dela**, não pela última execução: o coletor de observação roda três fontes numa chamada, e uma execução "com problema" pode ter falhado só numa — por isso INMET, Alerta Rio e Defesa Civil olham o texto do erro. A previsão é medida pelo **dado** (`coletada_em`), não pelo log, porque execução morta pelo limite de tempo não grava log. Tolerâncias: 3 h nas horárias, 7 h na previsão (um ciclo perdido), 36 h no robô da ANEEL. Atrasada → aviso no topo dizendo a **consequência** ("podem faltar avisos oficiais"). Em dia → só a linha do monitor (§5.8). **Validado contra o incidente real:** entre 08 e 12/10 o INMET ficou até 25 h seguidas sem sucesso e passou de 3 h três vezes — o aviso teria aparecido no primeiro dia. Sem e-mail, como manda a premissa. |
| 2026-10-15 | **Coletor de previsão: lote isolado e segunda tentativa com prazo** (v8). Em 10 dias a Open-Meteo custou 1 ciclo inteiro, 2 parciais e 1 que não deixou rastro. Pior que o 503 passageiro era um defeito nosso: um JSON truncado num lote escapava do laço e **matava a coleta inteira** (13/10 12h: 0 de 736). Agora cada lote é isolado; os que falham ganham uma segunda tentativa depois de 15 s, **só se faltarem mais de 45 s para o limite de 150 s** — passar do limite mata a execução sem log, o que é pior que perder o lote. Lote recuperado conta como sucesso, mas fica anotado no log ("recuperado na 2a tentativa") para medir com que frequência a segunda tentativa salva. **Testado de verdade**, com fetch e Supabase simulados sobre o código real: 503→OK recuperado, JSON truncado duas vezes falha só o próprio lote, lote seguinte gravado. Caminho feliz conferido em produção: 736 registros, 8,9 s. |
| 2026-10-15 | **Bug: avisos do INMET perdidos em silêncio por 53 horas (08 a 12/10).** O coletor junta as listas `hoje` e `futuro`; um aviso que vale hoje E amanhã vem nas duas, e o mesmo `(fonte, id_externo)` duas vezes no lote fazia o Postgres recusar o lote INTEIRO (`ON CONFLICT DO UPDATE command cannot affect row a second time`). Sumia sozinho quando o aviso expirava — e por isso ninguém viu por 4 dias. Migration 082: `distinct on` no servidor, vence a última ocorrência do lote. Corrigido no banco e não no coletor: vale para qualquer origem e não exige publicar Edge Function. Testado com identificador fictício, sem município, apagado na mesma chamada. |
| 2026-10-15 | **A carga da ANEEL foi blindada contra o mesmo defeito, antes que ele acontecesse.** `tempo_ingerir_observado` tinha a mesma forma (`DO UPDATE` sem garantia de chave única no lote). Hoje o robô agrupa por município-dia e não ocorre, mas se ocorresse cairia justamente na PRIMEIRA carga de setembro. |
| 2026-10-05 | **A coluna "Prob. chuva" da tabela também lê a calibração** (pedido do usuário; demais colunas intocadas). Era a última vitrine da fração bruta na página: agora topo, barras e tabela dizem o mesmo número para a mesma hora. |
| 2026-10-05 | **Revertido no mesmo dia por decisão do usuário: UMA tabela só, a que o painel exibe.** As quatro entradas abaixo (janela de 6 h, dia por antecedência, "sem medida", "dia incompleto") descrevem uma versão que existiu por algumas horas — migrations 079 → 080/081. O argumento do usuário: o número do topo tem de ser o da tabela que o leitor vê embaixo; com tabelas diferentes, o painel mostrava "25% → 18%" em cima e "25% → 13,6%" no cartão de calibração, e se contradizia. A diferença hora × janela foi exposta e o usuário manteve a escolha. **Agora: cartão das 6 h e todas as barras diárias leem a tabela horária, k de 8 → chance.** Os números medidos por janela ficam nas entradas abaixo como registro. |
| 2026-10-05 | **A linha duplicada de "5 de 8" era artefato, não dado.** As faixas eram de 10% sobre a fração média por hora, e horas com DUAS previsões da mesma família (emissões diferentes, pontos sentinela) davam frações como 9/16 = 57%, que o painel arredondava para "5 de 8" ao lado do 5 de 8 verdadeiro (63%). A calibração agora conta **uma previsão por família por hora, a mais recente** (menor horizonte), e só usa hora com as 8 famílias: k cai exatamente em 0..8, nove linhas, monotônicas. As 50 horas da linha falsa não foram "apagadas" — elas se redistribuíram nas faixas certas. |
| 2026-10-05 | **A 080 falhou ao rodar: `n` era variável PL/pgSQL e apelido de coluna ao mesmo tempo.** O Postgres recusa a referência ambígua. A chamada falhou inteira, então o `delete` dentro dela foi desfeito e a tabela antiga sobreviveu; a 081 renomeou o apelido antes da rotina das 04:50. |
| 2026-10-05 | **A fração de famílias virou probabilidade medida, no cartão das 6 h e nas barras diárias** (pedido do usuário). O número grande do topo era a fração bruta — que sabemos exagerar — e a chance honesta ficava em cinza miúdo embaixo. Agora são duas peças do mesmo tamanho: "X% das famílias preveem chuva" e "Y% de chance de chuva", nas próximas 6 h e em cada dia. |
| 2026-10-05 | **A calibração horária NÃO servia para isso, e foi preciso medir por janela.** Ela responde "choveu NAQUELA hora". Com 75% das famílias: hora 37%, **janela de 6 h 52%**, dia 48%. Reaproveitar a horária como "chance nas próximas 6 h" subestimaria em 15 pontos. `atualizar_calibracao` passou a calcular também `chuva_6h` (≥ 0,5 mm em alguma hora do bloco, blocos UTC 00/06/12/18) e `chuva_dia_*` (≥ 1 mm somado no dia local). Só entra bloco ou dia **completo** para as 8 famílias — bloco parcial teria menos chance por construção. As duas curvas saíram monotônicas: 5.611 janelas e 1.140 dias. |
| 2026-10-05 | **A fração do cartão de 6 h conta família com chuva em ALGUMA hora da janela, não na hora mais chuvosa.** Família A chovendo às 14h e B às 17h são duas vendo chuva, embora nenhuma hora tenha as duas. A contagem antiga (máximo horário) subcontaria e, cruzada com a calibração de janela, daria chance baixa demais. Vem de `tempo_janela_6h`, calculada sobre `previsao_horaria` — 3,7 ms por município. |
| 2026-10-05 | **A chance do dia só aparece para HOJE; os outros dias dizem "chance sem medida".** Confiabilidade cai com a antecedência, e a calibração diária foi medida quase toda com previsão de poucas horas. Separada por antecedência, só D0 tem amostra (1.140 dias contra 48 em D1-D2 e 32 em D3-D4); o pouco de longo prazo já sugere que previsão seca erra mais de longe (choveu 42% contra 16%, n=12). Emprestar a curva de hoje poria 87% de chance num dia a quatro dias de distância. A view só publica faixa com ≥ 30 casos, então os dias seguintes ganham o número **sozinhos** conforme os sentinelas acumulam. |
| 2026-10-05 | **Dia com menos de 18 h cobertas não recebe chance.** A calibração é de dia inteiro; aplicada a um pedaço de dia superestimaria. Aparece "dia incompleto". |
| 2026-10-05 | **O "concordam" de volume saiu das barras e virou cor.** Duas porcentagens na mesma linha (fração de famílias e concordância de volume) disputariam a leitura com a chance. Volume incerto (< 50% das famílias perto da mediana) agora pinta os milímetros de laranja, com a porcentagem no `title`. |
| 2026-10-05 | **O INMET negou o token (resposta de 2026-10-04).** Não há credencial de API para pessoa física: só o portal, o **BDMEP** (pedido manual por e-mail, arquivo histórico) e, para instituição, **Acordo de Cooperação Técnica**. Reconfirmado no dado no mesmo dia: o catálogo `/estacoes/T` é público (672 estações, **26 automáticas no RJ**, operantes), mas toda rota de dados devolve **204** — inclusive janeiro de 2025 numa estação operante, que com certeza tem medição. |
| 2026-10-05 | **O mapa público do INMET (`mapas.inmet.gov.br`) também não serve para coleta.** Sugestão do usuário, investigada: a página busca dados de estação por `POST {apimapas}/dados/` com `gcap: token` no corpo — um **token reCAPTCHA v3 gerado a cada requisição** — atrás de defesa anti-robô F5 (`/TSbd/`). Coletar por ali exigiria produzir tokens de CAPTCHA, isto é, se passar por humano: **descartado**, e seria contornar a decisão que o próprio INMET acabou de comunicar. O mapa é para pessoa olhando. |
| 2026-10-05 | **A negativa fecha DOIS caminhos, não um.** O token servia para (1) verificar **vento** — a previsão de rajada nunca foi conferida contra nada medido — e (2) cobrir com chuva medida os **28 municípios sem CEMADEN**. Os dois ficam abertos. |
| 2026-10-05 | **METAR dos aeroportos é a saída sem token para o vento.** `aviationweather.gov/api/data/metar` responde 200 sem credencial; **6 de 7 aeroportos do RJ** ao vivo (SBRJ, SBGL, SBJR, SBCB, SBME, SBCP; SBRS fora da janela testada), de hora em hora, padrão OMM. Cobre capital, Norte Fluminense, Lagos e Sul. Não resolve o caminho (2): METAR brasileiro não traz quantidade de chuva. **Avaliado, não implementado.** |
| 2026-10-05 | **METAR descartado por decisão do usuário: não cobre o estado.** São 6-7 pontos, todos em aeroporto, contra 92 municípios — a verificação de vento ficaria restrita a capital, Lagos, Norte Fluminense e Sul, sem Serrana nem Noroeste. A previsão de rajada segue **sem verificação medida**. Não repropor sem fonte que cubra o interior. |
| 2026-10-05 | **No METAR, rajada ausente não é dado ausente — é dado censurado.** O código só reporta rajada (`G`) quando ela passa a média em ~10 kt. `wgst: null` com `wspd: 10` diz que a rajada ficou abaixo de ~20 kt, não que ninguém mediu. Uma verificação que tratasse o nulo como falta jogaria fora justamente os dias calmos, e avaliaria a previsão de rajada só nos dias de vento forte — viés de seleção. |
| 2026-10-05 | **Alerta Rio não tem vento.** As 33 estações do JSON que já coletamos são todas `pluviometric`; variáveis só de chuva (`h01`…`h96`, `m05`, `m15`, `mes`). Descartado como fonte de vento. |
| 2026-10-03 | **O valor da concordancia voltou ao tamanho normal da tabela.** Eu tinha lido "colocar o dado maior" como maior que as outras colunas; era maior que a legenda abaixo dele. Com 15 px numa tabela de 12,5 px, a coluna passava a se ler como mais importante que as vizinhas — duas escalas de texto onde deve haver uma. Agora os sete valores principais medem 12,5 px e so o rodape mede 11 px. **Medido no getComputedStyle das sete colunas**, nao conferido no olho. |
| 2026-10-03 | **A coluna "Familias" da tabela virou "Concordancia", com o % grande e a contagem embaixo** (pedido do usuario). Tamanho separa o dado do rodape que o justifica, sem gastar outra cor. |
| 2026-10-03 | **Concordancia NAO e probabilidade, e por isso  virou 100%, nao 0%.** Concordar e as linhagens apontarem para o MESMO lado, qualquer que seja: se nenhuma preve chuva, as oito concordam — que nao chove. A coluna conta o maior dos dois lados. Aplicar o pedido ao pe da letra daria "0% de concordancia" num dia de consenso total, que e a mesma vagueza que o usuario ja tinha apontado no cartao principal. O rodape diz o lado: "6 de 8 concordam: chove" ou "...: seco", e empate tem texto proprio. |
| 2026-10-03 | **"Faixa p25-p75" virou "Faixa provavel" com a sublinha "metade central".** O rotulo anterior so dizia algo a quem ja sabe estatistica; o novo diz o que o numero e — a faixa onde cai a metade do meio das linhagens. A sublinha do cabecalho nao e maiuscula nem espacada como o titulo, porque e explicacao e nao rotulo. |
| 2026-10-03 | **A legenda virou tres linhas: avisos INMET, Defesa Civil, e a intensidade** (pedido do usuario). As duas fontes compartilham a rampa de cor mas tem vocabularios diferentes, e a legenda so nomeava o do INMET — quem via um selo cinza escrito BAIXO nao tinha onde confirmar o que aquilo valia. |
| 2026-10-03 | **As duas rampas ficam na MESMA grade CSS, nao em duas linhas flex empilhadas.** Colunas de grade so se alinham dentro do mesmo container: com dois flex separados, "Observacao" e "Muito baixo . Baixo" tem larguras diferentes e as cores desencontram. **Medido**: so a primeira coluna coincidia (157/157), as outras tres erravam por ate 37 px. Na mesma grade, as quatro batem exatamente. |
| 2026-10-03 | **O cinza aparece rotulado como "Muito baixo . Baixo".** A fonte publica cinco niveis e dois deles sao cinza; dizer so um faria o leitor procurar uma quinta cor que nao existe. |
| 2026-10-03 | **O selo "em vigor agora" passou a marcar tambem o risco da Defesa Civil** (pedido do usuario), em TODAS as linhas — o que a fonte publica e sempre o estado vigente. Sem ele, "desde qua 30/09" podia ler como aviso vencido. |
| 2026-10-03 | **O selo segue a rampa de gravidade, nao vermelho fixo.** O usuario pediu "vermelho", mas vermelho fixo poria selo de maxima gravidade num risco BAIXO — e esse foi exatamente o defeito ja corrigido no selo do INMET. Mantida a regra: matiz = gravidade. |
| 2026-10-03 | **A primeira versao do selo saiu toda cinza, e a captura de tela nao denunciou.** `.dc-alto .agora` tem a MESMA especificidade de `.alerta .agora` e estava escrita ANTES dela, entao perdia por ordem. So apareceu ao medir `getComputedStyle` nos seis niveis; olhar a tela nao bastou. Corrigido com `.alerta.dc-alto`, que ganha por especificidade e nao depende de ordem. |
| 2026-10-03 | **Eu contaminei `tempo.risco_municipio` com três linhas de teste, e elas venciam as reais.** Para validar a RPC de ingestão inseri à mão municípios **reais** com carimbos copiados de outros e uma prioridade inventada. Como os carimbos eram mais recentes, a view `distinct on ... order by atualizado_fonte desc` escolhia a linha falsa: o painel mostrava Búzios com prioridade 1 em vez de 2. Apagadas; o coletor repôs os valores verdadeiros na leitura seguinte, porque ele manda os 92 municípios toda hora. **Regra: teste de ingestão usa entidade fictícia, nunca nome real** — com nome real o dado falso não parece falso. |
| 2026-10-03 | **A Defesa Civil DESCE o nível quando normaliza — provado pela distribuição, não por suposição.** 75 dos 92 municípios estão em BAIXO no geológico; se só subissem, depois de anos nada estaria em BAIXO. A assimetria de idade fecha o argumento: o que está elevado tem 7 h em média, o que está em BAIXO tem 67 h. É o padrão de sobe-no-evento, desce-depois, fica parado até o próximo. |
| 2026-10-03 | **O risco da Defesa Civil mostra SEMPRE o estado vigente, em qualquer nível** (decisão do usuário, e ele está certo). Minha objeção — 84 dos 92 municípios em MODERADO — valia para um **mapa**, onde quase tudo acenderia junto. O painel mostra **um município por vez**, e para esse município saber que está em BAIXO é informação, não ruído: é a diferença entre "está calmo" e "não sei". |
| 2026-10-03 | **Rótulos: termo técnico primeiro, efeito concreto entre parênteses.** "Risco geológico (deslizamentos)" e "Risco hidrológico (enchentes)". A palavra da fonte fica, para quem for conferir no painel oficial; a tradução entra junto, para quem só quer saber o que pode acontecer. |
| 2026-10-03 | **A Defesa Civil publica MUDANÇA de nível, não boletim diário — e isso quase virou mentira na tela.** Medido em 03/10: o que está elevado é recente (0-9 h), mas municípios em BAIXO estavam parados havia até **4 dias**. O painel mostrava só "15h31", sem data, o que faria um nível de três dias atrás ler como hoje. Agora a data entra quando não é do dia: "desde qua 30/09 18h". Mesma falha do carimbo de `tempo.config`, duas vezes na mesma semana. |
| 2026-10-03 | **A legenda oficial tem CINCO níveis, não quatro — `MUITO BAIXO` faltava no mapa do coletor.** Ele cairia em `desconhecido`, e como desconhecido é exibido em vermelho no topo, o nível **mais brando** apareceria como o mais grave. Achado lendo a legenda da fonte, não esperando o dado quebrar. A fonte numera os níveis de 1 a 5 e publica o número na coluna Prioridade — a ordenação usa o número, não o texto. |
| 2026-10-03 | **Não existe previsão de risco, só estado atual.** As definições oficiais falam em "EVENTOS ESPERADOS" mas **sem janela de validade publicada**, e o painel é "MAPA EM TEMPO REAL" — não há view de amanhã. O futuro no cartão continua vindo do INMET ("a seguir") e da própria previsão das 8 linhagens. |
| 2026-10-03 | **O risco da Defesa Civil passou a aparecer no cartão de alertas**, em faixa própria **acima** da lista do INMET. Estado emoldura evento: o município "está em risco alto" é o contexto em que os avisos acontecem, então vem primeiro. Faixa separada, não item da lista — um estado permanente no meio de eventos leria como "mais um aviso que acabou de sair". |
| 2026-10-03 | **Uma rampa de cor só, compartilhada com o INMET.** Moderado→amarelo, alto→laranja, muito alto→vermelho, desconhecido→vermelho. Duas escalas no mesmo cartão obrigariam o leitor a lembrar qual é de quem; a fonte é dita por escrito ("Defesa Civil do RJ"), que é texto e não disputa canal visual (§5.6). |
| 2026-10-03 | **BAIXO e MODERADO não aparecem; desconhecido aparece.** 84 dos 92 municípios vivem em MODERADO no hidrológico — pintar quase todo o estado todo dia ensina a ignorar a cor. Mas nível **não mapeado** não é ocultado: se a Defesa Civil criar um nível novo, ele entra em vermelho em vez de sumir. |
| 2026-10-03 | **O cartão deixou de sumir quando não há aviso do INMET.** O código fazia `if (!av.length){ card.hidden = true; return; }` — com isso um município em risco geológico ALTO e sem aviso meteorológico não mostrava nada. Agora o cartão aparece se **qualquer** das duas fontes tiver o que dizer. |
| 2026-10-03 | **A busca do risco tem `.catch(() => [])`.** Fonte nova não pode derrubar a que já funcionava: se a view falhar, os avisos do INMET continuam aparecendo sozinhos. |
| 2026-10-03 | **Risco da Defesa Civil do RJ entrou como camada coletada** (geológico e hidrológico, 92 municípios, de hora em hora). Fonte: painel CEMADEN-RJ. **Não é API — é HTML renderado no servidor**, e por isso a trava `MIN_MUNICIPIOS = 85`: se o layout mudar, o parse falha alto no `coleta_log` em vez de gravar vazio em silêncio. |
| 2026-10-03 | **Risco é ESTADO, alerta é EVENTO — tabela separada de `alerta_oficial`.** Todo município sempre tem um nível, mesmo BAIXO; alerta do INMET começa, vale e acaba. Misturar faria o cartão de alertas ficar permanentemente cheio e perder o significado de "algo fora do normal". Por isso também a decisão de exibição: **só entra na tela acima de MODERADO**, e o hidrológico não entra — 84 dos 92 municípios vivem em MODERADO, uma escala que nessa faixa não discrimina nada. |
| 2026-10-03 | **A chave única é (município, tipo, `atualizado_fonte`), não o instante da coleta.** A leitura é ao vivo toda hora, mas a fonte só se atualiza uma punhada de vezes por dia — gravar cada leitura guardaria a mesma foto seis vezes. Quem decide o que é foto nova é o carimbo da fonte, e o banco recusa a repetida sozinho. |
| 2026-10-03 | **O painel do CEMADEN-RJ é UTF-8, e ler como latin-1 falha em silêncio.** Na primeira tentativa 30 dos 92 municípios não casaram — MACAÉ, PETRÓPOLIS, NITERÓI, todos os acentuados. Nenhum erro foi levantado: o nome só não encontrava par. Encoding errado não quebra, **corrompe**. |
| 2026-10-03 | **R11 reapareceu, agora em FUNÇÃO em vez de tabela.** `revoke all ... from public` na RPC de ingestão tirou junto o `service_role`, que é quem o coletor usa. Sintoma: HTTP 200 com `ok:false` e `permission denied`. A função não quebrou — só não conseguiu gravar. Corrigido igualando o ACL das outras duas RPCs em vez de inventar um novo. |
| 2026-10-03 | **O deploy de Edge Function reseta `verify_jwt` para `true` se o parâmetro for omitido.** A v7 subiu assim e teria derrubado a coleta inteira com 401 na hora seguinte. Pego antes do primeiro cron; v8 corrigiu. O aviso agora está no cabeçalho do próprio arquivo, onde quem for publicar vai ler. |
| 2026-10-03 | **Chuva acumulada reprovada como quarto driver de impacto** (D12, `9_testar_solo.py`). Hipótese: os três drivers são instantâneos e falta memória de solo. Resultado: MAE 9,200 → 9,168 (**0,35%**) e coeficiente **não monotônico** — sobe até +0,124 em 30-60 mm e vira **−0,052** acima de 60 mm. O CAPE, quando entrou, deu o dobro do ganho e zerou o viés. A correlação explica: o acumulado tira sinal do driver de chuva (`>=12mm` cai de +0,394 para +0,354) em vez de trazer sinal novo. Medido sobre 19.504 município-dia (2026 jan-jul), 16% da base de produção. |
| 2026-10-02 | **`tempo.config.atualizado` era um carimbo que mentia, e custou dois alarmes falsos.** A coluna tinha `default now()` e nenhum gatilho: registrava o INSERT e nunca mais se mexia. A linha do `coletor_segredo` mostrava 10/09 mesmo com o valor já rotacionado, e **duas sessões independentes** concluíram que a coleta podia estar tomando 401 em silêncio. Corrigido com gatilho `before update` que só move o carimbo quando o valor **muda de fato** — regravar o mesmo texto não é rotação. Um diagnóstico que mente é pior do que nenhum: custa investigação e produz alarme. |
| 2026-10-02 | **"Cron succeeded" não prova que a coleta funcionou.** `disparar_coleta()` apenas enfileira a chamada via `pg_net` e retorna com sucesso; um 401 chegaria depois, assíncrono, sem tocar no status do job. A prova de que o segredo casa é outra: `tempo.coleta_log` com `ok=true` e **736 registros** (92 pontos × 8 linhagens, ciclo completo) às 18:39:59 UTC, depois da rotação das 14:39. Verificar o agendador responde se ele disparou, não se o outro lado aceitou. |
| 2026-10-02 | **O segredo que vazou no git é `tUfLMsTl…`, e está morto.** Aparecia hardcoded nos dois coletores no histórico; não existe mais na árvore de trabalho e não é nenhum dos valores vivos. O segredo em uso nunca foi commitado — testado com `git log -S` sobre o valor exato. |
| 2026-10-02 | **A carga do observado da ANEEL foi automatizada em GitHub Actions**, uma vez por dia. 29 dias por mês custa **149 KB** — só o rodapé do parquet, que diz até que mês de competência o arquivo vai. No dia em que a competência alcança um dia com previsão congelada, baixa as 2 colunas que importam (54 MB de 195, porque parquet é colunar), agrega o RJ e grava. ~13 min/mês dos 2.000 gratuitos. Não cabia em Edge Function (54 MB e ~4 min contra o limite de 150 s) nem devia rodar na máquina do usuário (premissa nº4). |
| 2026-10-02 | **R9 resolvido, e desta vez sozinho.** O segredo saiu do fonte dos dois coletores e foi rotacionado. Na primeira tentativa, horas antes, isto vinha de carona na automação da ANEEL e foi descartado junto com ela — misturar as duas coisas é o que tornava a mudança confusa. Feito isolado: um secret no Supabase, um deploy, uma atualização de `tempo.config`. |
| 2026-10-02 | **Eu subestimei a janela de manutenção, e o dado mostrou.** Disse "minutos"; foram **~6 horas** para a previsão. O erro foi pensar na duração da janela em vez da **cadência do que roda dentro dela**: a observação roda de hora em hora e perdeu uma; a previsão roda a cada 6 h, e perder um ciclo envelhece a emissão mais nova além das 6 horas. Efeito visível em `tempo.verificacao`: das 14h às 18h UTC, **zero pares em 0-6h** e os ~470/hora caíram em 6-24h. Não é perda — a classificação está correta, aqueles pares eram mesmo de 6-24h. Perdeu-se ~5 horas de amostra em 0-6h, de 444. Regra para a próxima: medir a janela pela rotina mais lenta que ela atravessa. |
| 2026-10-02 | **A janela de falha foi aceita em vez de eliminada.** Entre o deploy do código novo e a atualização do `tempo.config` as coletas recusam por autenticação. Evitar isso exigiria código que aceita os dois segredos e um segundo deploy para removê-lo — mais processo do que o problema merece, já que a coleta é idempotente e a seguinte recupera. Minimizar, não eliminar. |
| 2026-10-02 | **Cartão de alertas colapsado em duas linhas** (ideia do usuário). Em dia carregado o INMET emite 7, 8 avisos e o cartão empurrava a previsão inteira para fora da tela — medido: 622 px abertos contra 308 fechados. Ficam à vista **o que está em vigor agora** e **o pior que ainda vem**, com selo distinguindo os dois; o resto entra num botão que diz quantos são. |
| 2026-10-02 | **O selo de tempo do alerta passou a seguir a rampa de gravidade** (observação do usuário). Era vermelho fixo, o que punha selo de máxima gravidade num aviso de PERIGO enquanto o GRANDE PERIGO ao lado ficava cinza — a cor dizia o contrário do dado. Agora segue a mesma rampa do ícone: cinza, amarelo, laranja, vermelho. |
| 2026-10-02 | **Gravidade não mapeada deixou de ser rebaixada em silêncio** (pergunta do usuário: "e se amanhã aparecer uma que existe mas não foi mapeada?"). O coletor fazia `SEVERIDADE[...] ?? 'observacao'` — um nível novo, possivelmente **mais grave**, virava o mais brando de todos, ia para o fim da ordenação e a palavra original se perdia. Agora vira `desconhecida`, e a palavra e a cor originais do INMET ficam em `bruto`. |
| 2026-10-02 | **O risco não é hipotético: o INMET publica 3 níveis com `id_severidade` 6, 7 e 8.** A numeração começar em 6 diz que a tabela deles tem (ou teve) outros. Não há garantia de que um 9 não apareça. |
| 2026-10-02 | **Nível desconhecido ordena no TOPO, não no fim.** Ordenar alto é palpite; ordenar baixo também — e dos dois, este falha do lado seguro. Enterrar um aviso possivelmente mais grave que "grande perigo" no fim de uma lista colapsada seria o pior erro possível num cartão de alerta. |
| 2026-10-02 | **Para o que não conhecemos, quem rotula e colore é a fonte.** O painel usa a palavra e o `aviso_cor` que o INMET publicou, em vez de inventar um rótulo ou mostrar cinza — cinza leria como "brando". Testado com um nível fictício: aparece no topo, roxo, escrito `PERIGO EXTREMO`. |
| 2026-10-02 | **Legenda da rampa acima da lista, e o selo de gravidade também colorido** (pedido do usuário). O selo da palavra entra **contornado**, não cheio: dois chips cheios lado a lado disputariam a leitura. Ficou **contorno = rótulo, cheio = vale agora, esmaecido = ainda vem**. |
| 2026-10-02 | **As amostras "cheio/esmaecido" da legenda usam o cinza da própria legenda**, não uma cor nova. Qualquer outra seria uma quinta cor competindo com a rampa de gravidade e desmentindo a regra que a legenda acabou de ensinar. |
| 2026-10-02 | **"Agora" e "a seguir" deixaram de ser codificados por cor.** Com a cor ocupada pela gravidade, o tempo migrou para **intensidade**: selo cheio vale agora, esmaecido ainda vem. É a §5.6 aplicada — um canal por dimensão. Texto escuro sobre amarelo e laranja, branco sobre vermelho: branco sobre amarelo é ilegível. |
| 2026-10-02 | **As duas linhas respondem perguntas diferentes, e por isso nenhuma substitui a outra.** A segunda não é "o pior da janela" e sim "o pior do que ainda vem": quando o aviso vigente já é o mais grave, aquela definição colapsaria as duas numa só e o leitor perderia o que está por vir — que é exatamente a informação que sobra depois de saber o agora. |
| 2026-10-02 | **O robô bate ponto todo dia, mesmo sem nada a fazer.** Ele não deixava rastro em `tempo.coleta_log`, onde todos os coletores registram — então morrer calado seria indetectável, e o GitHub **desativa workflow agendado após 60 dias sem atividade no repositório**, cenário provável num projeto pessoal. Nos 29 dias por mês sem novidade ele chama a função com lista vazia: custa alguns bytes e é a diferença entre "está esperando" e "parou". É a falha recorrente deste projeto — a faixa 24-72h da verificação ficou 17 dias congelada sem ninguém notar. |
| 2026-10-02 | **Primeiro desenho descartado por excesso de processo**, a pedido do usuário. A versão inicial criava uma Edge Function só para validar um segredo, e de carona rotacionava o segredo dos coletores (R9) — o que exigia secret no painel do Supabase, deploy de três funções e uma janela em que a coleta quebraria. Processo demais para "uma vez por dia, olha e atualiza". O robô passou a chamar a função do banco direto pelo PostgREST: **dois secrets no GitHub, zero deploy**. A lição: resolver duas coisas num pacote só parece economia e é o que torna a mudança difícil de revisar e de desfazer. O R9 voltou a ser pendência própria. |
| 2026-10-02 | **O segredo da ingestão é próprio dessa porta**, guardado em `tempo.config`, e não o dos coletores. Ele autoriza **uma escrita** e não dá acesso a dado nenhum — bem diferente de entregar a `service_role` key ao CI, que era a alternativa. |
| 2026-10-02 | **Medido: o ranking das linhagens depende do horizonte.** ARPEGE cai de 4º para 7º entre 0-6h e 6-24h; UKMO sobe de 7º para 3º; ICON lidera em todas. Confirma por medida a decisão de pesar por (região × horizonte), que até aqui era princípio. Ver §9.7. |
| 2026-10-02 | **O projeto passou a ter repositório:** `LuisLopesCruz/tempo`, privado. Entram painel, Edge Functions, schema, coeficientes, procedimento de calibração e este documento — 20 arquivos, 310 KB. Ficam de fora os ~328 MB de ERA5/CAPE, rebaixáveis pelos scripts. Privado por causa do R9: o segredo do coletor está em texto claro no código e **agora está no histórico** — o conserto é rotacionar, não remover, porque histórico de git não esquece. |
| 2026-10-02 | **Commit a cada alteração, por pedido do usuário.** Repositório atualizado só quando alguém lembra envelhece em silêncio e passa a mentir sobre o estado do sistema — pior do que não ter. Migração no Supabase não gera arquivo: registra-se a decisão aqui e commita-se o registro. |
| 2026-10-01 | **A verificação só media as próximas 6 horas** (migration 067). `tempo.verificar()` guardava, por hora, só a emissão mais recente — e como a coleta roda a cada 6 h, toda previsão verificada tinha menos de 6 h de antecedência. A faixa 24-72h estava parada desde 14/09 e a 72-120h nunca existiu: o painel mostrava 5 dias e sabia medir o primeiro. |
| 2026-10-01 | **Faixas longas só em 8 pontos-sentinela, um por região.** Abrir as 4 faixas nos 92 municípios levaria `verificacao` a ~440 MB, contra o R13. Não perde poder: os grupos de skill já são regionais e a trava de 72 horas distintas existe porque município extra sob a mesma chuva não acrescenta evidência. Custo medido: +9 MB imediatos, ~+48 MB em regime. |
| 2026-09-28 | **Alerta Rio descartado como fonte de vento** (decisão do usuário). Os dados existem em 8 estações, mas sem feed pública ao vivo — só arquivo histórico por formulário. Uma cidade, download manual, sem ciclo diário: não paga a manutenção. Ver §9.8. |
| 2026-09-28 | **Agregador radarmeteorologico.com.br descartado.** O endpoint de temperaturas declara `"fonte": "Open-Meteo e MET Norway"` — não é observação do INMET. Verificar previsão do Open-Meteo contra o Open-Meteo mediria a concordância do sistema consigo mesmo. Só o endpoint de alertas é INMET de verdade, e alertas já temos. |
| 2026-09-28 | **Dados horários do INMET exigem token.** A rota aberta `/estacao/{datas}/{cod}` responde **204 em silêncio** para toda estação e toda data; `/token/estacao/.../{chave}` responde `CHAVE INVÁLIDA!`. Nunca foi bloqueio de rede: `pg_net` do Supabase alcança o INMET normalmente — quem apanha é o `curl` desta máquina, por fingerprint de TLS. Token solicitado por e-mail em 2026-09-28. |
| 2026-09-28 | **A calibração passou a ser mostrada** (migration 066). Era medida todo dia desde o início e nunca lida. Diz que o painel é otimista por ~2×: quando as 8 famílias concordam, chove em 43% das vezes. Ver §9.8. |
| 2026-09-28 | **A fração de concordância tem skill de Brier NEGATIVO** (−18%) lida como probabilidade, e **+13%** lida pela tabela medida. A frequência observada é monotônica, então o painel ordena bem e só erra a escala. |
| 2026-09-28 | **Tile de temperatura no topo**, e sem etiqueta de calor por limiar fixo: o alerta oficial sobrepõe (§5.3), e limiar meu que não dispara em GRANDE PERIGO vigente seria lido como "não há problema" (§5.8). |
| 2026-09-28 | **Os pesos por skill entraram em vigor** — 9 de 24 grupos, 204.120 verificações. O gargalo foi sempre a trava de horas distintas, nunca a de amostras. Ver §9.7. |
| 2026-09-28 | **`skill_grupos_ativos` contava linhas, não grupos.** O painel exibia "72 grupos" onde existem 24 no total, porque `tempo.skill` tem uma linha por (grupo × linhagem). Migration 065. Número certo sob rótulo errado é número errado. |
| 2026-09-28 | **Riscos R1, R4, R5 e R7 encerrados** e movidos para tabela própria, com o desfecho registrado. R1 caiu por evidência: 18 dias de operação contínua sem pausa. |
| 2026-09-28 | **R13 aberto: o armazenamento cresceu além da projeção.** 132 MB no schema contra ~71 MB previstos; 280 MB no banco compartilhado. A retenção funciona — errou o custo por linha. Alavancas listadas antes de precisar delas. |
| 2026-09-15 | **Cartão de condição do tempo, com `cloud_cover`** (migration 063). Motivado por observação do usuário: só probabilidade de chuva deixa o dia bom preto, e preto se confunde com falha de coleta. Precedência: chuva manda no ícone, nuvem decide o resto. Ver §5.8 e §12.2. |
| 2026-09-15 | **"0 de 8 concordam" dizia o oposto dos dados.** A barra conta quem vê chuva; em dia seco as oito concordam. A palavra *concordam* passou a ser reservada ao voto unânime. Ver §5.8. |
| 2026-09-15 | **Monitor de aprendizado e desempenho** (migrations 062 e 064). Decisão de projeto: **mostrar a medição antes de ela valer, marcada como provisória**. E não coroar líder quando o período foi seco — "ainda empatados: todos acertam prevendo zero". |
| 2026-09-15 | **Deploy de Edge Function passa a ser pela CLI do Supabase**, não pelo MCP. O R8 (schema degradado) não se resolve na sessão; a CLI lê o arquivo do disco e elimina a transcrição manual. |
| 2026-09-15 | **Filtro hierárquico por região descartado depois de construído**, a pedido do usuário: exige saber a geografia antes de achar o município. Região e concessionária foram **promovidas a rótulo** — subtítulo no Top-5, resumo agregado no panorama — em vez de deletadas. Ver §12.2. |
| 2026-09-15 | **Busca de município ignorando acento e caixa**, no lugar do `<select>` de 92 itens. `<datalist>` nativo foi descartado: não normaliza acento, que é justamente o caso difícil no RJ. |
| 2026-09-12 | **Toda tabela de heatmap declara largura por `<colgroup>`.** Com `table-layout:fixed` o navegador tira a largura da **primeira linha**, que é o cabeçalho — regra posta no `<td>` do corpo é ignorada, e a coluna de data invadiu as células. |
| 2026-09-12 | **`node --check` no bloco `<script>` extraído** vira o método padrão de validar o painel. Contagem de chaves provou-se não confiável; a primeira rodada do `node --check` pegou um `Identifier 'hoje' has already been declared` que teria quebrado a página inteira. |
| 2026-09-11 | **CAPE entra como terceiro driver, não como substituto.** Medido: sozinho empata com a chuva, junto vence — correlação entre eles é só +0,33. O que destravou foi descobrir que a Open-Meteo arquiva previsões passadas, não só reanálise. Ver §9.6. |
| 2026-09-11 | **`risco_energia` passa a ser servido por snapshot.** Recalcular 2,2 s a cada carregamento raspava o timeout de 3 s do anon; os dados mudam 4× por dia. Mesmo padrão do `tempo_status`. |
| 2026-09-11 | **O impedimento da verificação de impacto era amnésia, não atraso.** `risco_energia` é view calculada na hora; nada guardava a previsão. Agora `impacto_snapshot()` congela diariamente por antecedência, e `impacto_pontuar()` produz Brier quando o lote chega. Ver §10.1. |
| 2026-09-11 | **Base da camada 3 passa a ser por (município, ano).** O nível de chamados varia 23% entre 2023 e 2025; com base única essa tendência entraria como se fosse efeito do tempo. Coeficientes vêm de todos os anos, o nível vem só do ano completo mais recente. |
| 2026-09-11 | **Schema da ANEEL não é estável entre anos.** 2026 mudou nomes de coluna e tipos. O script passou a detectar o layout em vez de assumir. |
| 2026-09-11 | **A chance no pior cenário caiu de 44% para 32,5% com 3× mais amostra.** Ficou registrado que o número antigo era o otimista, não o novo o pessimista — é o tipo de correção que só aparece ampliando a base. |
| 2026-09-11 | **Camada 3 v4: coeficiente vem do total observado, não do rótulo de causa.** O usuário apontou que as distribuidoras classificam errado; isso derruba o rótulo como medida de magnitude e explica o teto da v3. Ver §9.4. |
| 2026-09-11 | **Escala 0–100 de gravidade descartada; probabilidade no lugar.** O modelo prevê o valor esperado e satura em 53/100 — ancorar 100 no p99 criaria topo inalcançável. "Chance de entrar nos 10% piores" é fixa, verificável por Brier e vai de 4,4% a 44%. |
| 2026-09-11 | **Alvo continua sendo chamado, não interrupção distinta.** Interrupção seria fisicamente melhor, mas o id só existe em 27% dos chamados da Light contra 77% da Ampla. Viés de registro subcontaria a capital. |
| 2026-09-11 | **Chuva diária agregada na ordem certa.** O cartão somava os p25/p75 horários para formar a faixa do dia — soma de quantis não é quantil da soma, e isso inflava a dispersão. Agora cada família fecha o total do dia primeiro. A linha cinza saiu; virou % de concordância, que se lê. |
| 2026-09-11 | **Concordância só existe quando há volume para discordar.** Em dia seco a métrica subia a 88% dizendo apenas "concordam que não chove" — inflada onde menos informa. Abaixo de 1 mm o painel mostra quantas famílias veem chuva. |
| 2026-09-11 | **Cartão "% do esperado para o mês" (ideia do usuário).** 30 mm não diz nada; "32% do que setembro inteiro traz" diz. Normal 1991–2020 do ERA5, escala fixa com barra cheia = o mês num dia só. |
| 2026-09-11 | **Varredura semanal vigia, não recalibra.** Recalibrar exige 380 MB e regressão — não cabe em Edge Function nem no Postgres. O CKAN publica `last_modified`, então dá para saber que mudou sem baixar um byte. |
| 2026-09-11 | **O painel parou de mentir sobre o próprio aprendizado.** O `tempo.status_snapshot` declarava `pesos_em_uso = true` e "8 grupos ativos" usando o critério antigo de 30 amostras — anunciando que o sistema já aprendera quando ele não aprendera. Passou a usar o mesmo piso duplo da `atualizar_skill`. Também passou a contar as duas redes (236 estações, união de Alerta Rio + CEMADEN) e a expor `municipios_observados`, em vez de reportar só a capital. |
| 2026-09-11 | **Sobrecarga de função pega antes de quebrar o cron.** Ao dar um segundo parâmetro à `atualizar_skill`, ficaram duas versões coexistindo — e `select tempo.atualizar_skill()` sem argumentos viraria ambígua, falhando todo dia às 04:40 **em silêncio**, porque `pg_cron` não reclama para ninguém. A antiga foi removida na migration seguinte. Lição: `create or replace function` com assinatura diferente **não substitui, acumula**. |
| 2026-09-11 | **CAPE publicado e confirmado em produção.** 644 de 736 linhas por emissão. Na primeira coleta apareceu o achado que importa: as linhagens discordam na **ordem de grandeza** (mediana ECMWF 460 J/kg contra 30 do GFS), porque cada centro define CAPE de um jeito e a Open-Meteo não normaliza. Limiar terá de ser por linhagem. Ver D11. |
| 2026-09-11 | **Painel: cor = causa, palavra = gravidade.** Ver §5.6. Também corrigido o vazamento de `MODERADO` por baixo da barra — coluna fixa de 78px com conteúdo variável. |
| 2026-09-11 | **Verificar renderizado, não só o diff.** Ao criar a legenda usei `class="legenda"`, que **já existia** para o mapa de calor; minha regra `display:grid` sequestrou a original `display:flex` e virou a fila de cores em coluna. Só apareceu ao abrir a página. Diff limpo não é página correta. |
| 2026-09-11 | **Fuso verificado, não presumido.** `pg_cron` é UTC e não há o que ajustar; o que precisava estar em horário de Brasília — o agrupamento por dia civil na camada 3 e no CEMADEN — já estava, explicitamente. Ver §12. |
| 2026-09-11 | **CEMADEN entra pelo `getJson2.php?uf=RJ`.** A verificação deixa de ser só da capital: 64 municípios, 8 regiões. O que estava errado antes era a conclusão, não a fonte — eu tinha julgado pelo arquivo `311_24.json` sem ver que ele é a camada de pluviômetros do país inteiro. |
| 2026-09-11 | **Coletor do CEMADEN roda no Postgres (`pg_net`), não em Edge Function.** É um GET de JSON plano; não valia um segundo coletor. Diferente do caso do CAPE, onde duplicar o coletor multi-lote da Open-Meteo seria pior que esperar. |
| 2026-09-11 | **Observação agregada em vetor de 24 horas por município/dia.** Formato longo custaria ~125 MB nos 120 dias de retenção; o vetor custa ~3 MB. Média, mediana e máxima guardadas juntas — observação não se recoleta. |
| 2026-09-11 | **Piso de skill passa a exigir horas distintas, não só volume.** Com 64 municípios, 30 amostras podem ser 30 municípios *na mesma chuva* — uma observação repetida 30 vezes. Passou a exigir 72 horas civis distintas. Verificado no dado: 85 amostras vindas de 11 horas, que teriam definido peso sob a regra antiga. |
| 2026-09-11 | **Alerta Rio tem prioridade sobre CEMADEN onde os dois cobrem.** Rede mais densa e nativa horária na capital. Uma observação por (ponto, hora) — duas inflariam a amostra do Brier. |
| 2026-09-10 | Escopo inicial: Estado do RJ |
| 2026-09-10 | Grid para calcular, município para comunicar — **revisado** para ~120 pontos representativos por causa do limite de 500 MB |
| 2026-09-10 | Horizonte: nowcasting até 5 dias |
| 2026-09-10 | Supabase como backend integral (banco + cron + coletor + proxy) |
| 2026-09-10 | HTML como consumidor puro, sem lógica de coleta |
| 2026-09-10 | Hospedagem gratuita aceita (não `file://`) |
| 2026-09-10 | Botão "faltou luz aqui" como ground truth de impacto |
| 2026-09-10 | Ordem de construção: chuva → energia → deslizamento |
| 2026-09-10 | Deslizamento terceirizado ao CEMADEN — não reconstruir |
| 2026-09-10 | Probabilidade sempre acompanhada de dispersão e nº de linhagens concordantes |
| 2026-09-10 | **Projeto Supabase novo e dedicado. `legno-lp` não deve ser tocado.** |
| 2026-09-10 | RADAR descartado como fonte — Power BI fechado, sem API, e sequer publicado |
| 2026-09-10 | Alerta por e-mail: **não agora**, mas gatilho construído e desarmado |
| 2026-09-10 | Schema escrito em `sql/001_schema.sql` — append-only, JSONB, RLS, retenção |
| 2026-09-10 | Pontos **não** são chumbados à mão: seed vem do IBGE (UF 33) + geocodificação, para não fabricar coordenadas |
| 2026-09-10 | TEMPO abrigado como schema `tempo` dentro do `PregadorAPP` (limite de 2 projetos free) |
| 2026-09-10 | Cadência de coleta a cada 6 h — os modelos globais só rodam em 00/06/12/18 UTC; coletar mais seria duplicar dado e queimar orçamento |
| 2026-09-10 | Probabilidade calculada por **família de modelo**, não por fonte — princípio 5.1 virou SQL |
| 2026-09-10 | Pesos por skill deliberadamente **não** aplicados enquanto não houver verificação: sem evidência, sem preferência |
| 2026-09-10 | Botão "faltou luz" **removido** a pedido do usuário; escrita pública fechada |
| 2026-09-10 | Painel de interrupções da ANEEL existe e é linkado, mas fica como **consulta manual** (Power BI sem API) |
| 2026-09-10 | Artifact descartado como hospedagem: o CSP dele bloqueia `fetch` para o Supabase. Hospedagem externa é exigência técnica, não preferência |
| 2026-09-10 | **Supabase Edge Function descartada como hospedagem da página** — testado e falhou, ver abaixo |
| 2026-09-10 | Observação: **mediana entre estações** como observado do ponto. A célula do modelo (13–25 km) é média de área; comparar com um pluviômetro só penalizaria o modelo injustamente |
| 2026-09-10 | Verificação **só com horizonte estritamente positivo**. A API devolve as horas passadas do dia junto com a previsão — são análise, não previsão; verificar contra elas inflaria o skill |
| 2026-09-10 | Alinhamento temporal: leitura do Alerta Rio arredondada para a hora mais próxima, porque a precipitação horária do Open-Meteo é a soma da hora **anterior** |
| 2026-09-10 | Peso mínimo de **0,25** por linhagem: nunca silenciar um modelo por completo — ele pode ser o único a acertar o evento raro |
| 2026-09-10 | Mínimo de **30 amostras** por grupo antes de qualquer peso sair de 1.0 |
| 2026-09-10 | `tempo_status` **sem** `security_invoker`: expõe contagens agregadas sem dar acesso às linhas internas |
| 2026-09-11 | Camada 3 usa o **maior** multiplicador entre chuva e vento, nunca o produto — não são causas independentes no mesmo temporal |
| 2026-09-11 | Baseline por município = mediana em **dias calmos** (< 1 mm, < 30 km/h), não a média geral: a média já embute os dias de tempestade |
| 2026-09-11 | `p90` viaja sempre junto da mediana nos limiares — esconder a dispersão na camada 3 seria o mesmo erro que §5.5 proíbe na camada 1 |
| 2026-09-11 | Processamento pesado em **venv descartável** no diretório temporário; nada instalado no Python do usuário, 629 MB apagados ao final |

### Hospedagem: alternativas testadas e descartadas

| Alternativa | Resultado |
|---|---|
| **Artifact (claude.ai)** | ❌ CSP bloqueia `fetch`/XHR para hosts fora da allowlist. Não conseguiria falar com o Supabase. |
| **Supabase Edge Function servindo o HTML** | ❌ **Testado em 2026-09-10.** A função responde 200 com os bytes certos, e cabeçalhos próprios passam (o `Cache-Control` chegou intacto), mas a plataforma **sobrescreve o `Content-Type` para `text/plain`** e injeta `X-Content-Type-Options: nosniff`. É política antiphishing do domínio compartilhado `*.supabase.co`. O navegador renderizaria como texto puro. Função `tempo-rj` ficou publicada porém inerte. |
| **Cloudflare Workers/Pages** | ❌ O conector disponível só expõe ferramentas de leitura (`workers_list`, `workers_get_worker_code`). Não há como publicar por MCP. |
| **Vercel** | ✅ **Em uso.** Deploy funciona pelo MCP; só a *Deployment Protection* exige um clique manual (D5). |

---

## 16. Fontes consultadas

- [ANEEL — anúncio do RADAR](https://www.gov.br/aneel/pt-br/assuntos/noticias/2025/aneel-anuncia-o-lancamento-de-sistema-para-monitorar-interrupcoes-de-energia)
- [ANEEL — Interrupções de Energia Elétrica nas Redes de Distribuição (dados abertos)](https://dadosabertos.aneel.gov.br/dataset/interrupcoes-de-energia-eletrica-nas-redes-de-distribuicao)
- [Cenário Energia — detalhes do projeto RADAR](https://cenarioenergia.com.br/2025/11/19/aneel-avanca-no-projeto-radar-nova-plataforma-nacional-para-monitoramento-em-tempo-real-das-interrupcoes-de-energia/)
- [ABRADEE — apresentação da ferramenta](https://abradee.org.br/aneel-apresenta-ferramenta-para-monitorar-quedas-de-energia/)
- [Canal Solar](https://canalsolar.com.br/aneel-lanca-sistema-quedas-energia-tempo-real/)

**Observação meteorológica (levantadas e testadas em 2026-09-11):**

- CEMADEN — dados por UF, em uso: `https://resources.cemaden.gov.br/graficos/interativo/getJson2.php?uf=RJ`
- CEMADEN — camada nacional de pluviômetros automáticos (JSONP, 2,1 MB): `https://resources.cemaden.gov.br/dados/311_24.json`
- CEMADEN — mapa interativo, de onde saíram os endpoints: `https://mapainterativo.cemaden.gov.br/`
- CEMADEN — download histórico mensal: `mapainterativo.cemaden.gov.br/download/download_form.php` — ⛔ **tem CAPTCHA e é arquivo mensal**; não serve para coleta automática e não deve ser contornado.
- INMET — lista de estações (funciona): `https://apitempo.inmet.gov.br/estacoes/T` — 26 automáticas operantes no RJ, com coordenadas.
- INMET — dados de estação: `https://apitempo.inmet.gov.br/estacao/{ini}/{fim}/{cod}` — ⛔ **204 sem conteúdo em toda data testada** (2024 a 2026). A rota existe, as vizinhas dão 404 e `/token/estacao/.../{token}` responde 200: **os dados foram fechados atrás de token**. É o caminho para cobrir os 28 municípios sem CEMADEN, vários dos quais têm estação INMET (Macaé, Cabo Frio, Carmo, Arraial do Cabo, Silva Jardim, Paty do Alferes).

*(Disponibilidade, formato e termos de uso de cada fonte de dados serão
confirmados no momento da implementação — não assumidos de memória.)*
