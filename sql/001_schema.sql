-- ============================================================================
-- TEMPO-RJ — Schema inicial
-- ----------------------------------------------------------------------------
-- Princípios aplicados (ver PROJETO.md §5):
--   * APPEND-ONLY: previsão nunca é sobrescrita. Toda linha nasce com
--     emitida_em / valida_para / linhagem.
--   * LINHAGEM: o voto é por modelo de origem, nunca por "fonte".
--   * ORÇAMENTO: série horária de 120h vira UM blob JSONB, não 120 linhas.
--   * ESQUECIMENTO: previsão bruta expira; o SKILL destilado é permanente.
-- ============================================================================

create schema if not exists tempo;

-- ============================================================================
-- 1. REFERÊNCIA
-- ============================================================================

-- Regiões de governo do RJ. Usadas para agrupar o cálculo de skill:
-- um modelo bom na Serrana pode ser ruim no Litoral.
create type tempo.regiao_rj as enum (
  'metropolitana',
  'serrana',
  'norte',
  'noroeste',
  'baixadas',
  'costa_verde',
  'medio_paraiba',
  'centro_sul'
);

-- Pontos de cálculo (~120). Populados pelo bootstrap a partir da lista
-- oficial de municípios do IBGE (UF 33) + geocodificação. Nunca chumbados
-- à mão, para não fabricar coordenadas.
create table tempo.ponto (
  id             smallint generated always as identity primary key,
  municipio_ibge integer      not null,
  municipio      text         not null,
  rotulo         text         not null,          -- 'Petrópolis' | 'Petrópolis — Itaipava'
  regiao         tempo.regiao_rj not null,
  lat            numeric(7,4) not null,
  lon            numeric(7,4) not null,
  altitude_m     smallint,
  -- ponto que representa o município na comunicação (§3: grid calcula,
  -- município comunica). Exatamente um por município.
  principal      boolean      not null default false,
  ativo          boolean      not null default true,
  criado_em      timestamptz  not null default now(),
  unique (municipio_ibge, rotulo)
);

create unique index ponto_um_principal_por_municipio
  on tempo.ponto (municipio_ibge) where principal;

create index ponto_regiao_idx on tempo.ponto (regiao) where ativo;

-- Linhagens de modelo. O antídoto contra a falsa maioria (§5.1).
-- Doze apps que rodam GFS por baixo contam como UMA linha aqui.
create table tempo.linhagem (
  id           smallint generated always as identity primary key,
  slug         text    not null unique,     -- 'ecmwf_ifs025'
  nome         text    not null,            -- 'ECMWF IFS 0.25°'
  origem       text    not null,            -- 'ECMWF' | 'NOAA' | 'DWD' ...
  tipo         text    not null
               check (tipo in ('global','mesoescala','ensemble')),
  resolucao_km real,
  -- identificador do modelo na API Open-Meteo, quando aplicável
  om_model     text,
  ativa        boolean not null default true,
  -- previsões independentes? duas linhagens do mesmo centro (ex.: IFS e AIFS)
  -- não são totalmente independentes; agrupa o desconto de concordância.
  familia      text    not null
);

comment on column tempo.linhagem.familia is
  'Agrupa linhagens correlacionadas. Concordância entre linhagens da mesma '
  'família vale menos que entre famílias distintas (§5.1).';

-- ============================================================================
-- 2. PREVISÃO (append-only, JSONB, expira)
-- ============================================================================

create table tempo.previsao (
  id            bigint generated always as identity primary key,
  ponto_id      smallint     not null references tempo.ponto(id),
  linhagem_id   smallint     not null references tempo.linhagem(id),
  -- quando o modelo rodou (ciclo). Se a fonte não informa, cai para coletada_em.
  emitida_em    timestamptz  not null,
  coletada_em   timestamptz  not null default now(),
  inicio_serie  timestamptz  not null,
  passo_horas   smallint     not null default 1,
  n_passos      smallint     not null,
  -- { "precip_mm":[...], "vento_kmh":[...], "rajada_kmh":[...],
  --   "temp_c":[...], "umidade":[...], "prob_precip":[...] }
  -- Arrays paralelos alinhados a inicio_serie + i*passo_horas.
  dados         jsonb        not null,
  unique (ponto_id, linhagem_id, emitida_em)
);

create index previsao_expurgo_idx on tempo.previsao (coletada_em);
create index previsao_busca_idx
  on tempo.previsao (ponto_id, emitida_em desc);

comment on table tempo.previsao is
  'APPEND-ONLY. Jamais fazer UPDATE. Expira em 10 dias (ver job de retenção).';

-- ============================================================================
-- 3. OBSERVAÇÃO (a verdade — corrige a previsão)
-- ============================================================================

create table tempo.observacao (
  id         bigint generated always as identity primary key,
  fonte      text        not null
             check (fonte in ('inmet','cemaden','alertario','redemet','inea')),
  estacao    text        not null,
  ponto_id   smallint    references tempo.ponto(id),
  medido_em  timestamptz not null,
  variavel   text        not null,   -- 'precip_1h' | 'rajada_kmh' | 'temp_c' ...
  valor      real,
  unique (fonte, estacao, medido_em, variavel)
);

create index observacao_janela_idx on tempo.observacao (medido_em desc);
create index observacao_ponto_idx  on tempo.observacao (ponto_id, medido_em desc);

-- ============================================================================
-- 4. ALERTA OFICIAL (sobrepõe a previsão — não vota nela, §5.3)
-- ============================================================================

create table tempo.alerta_oficial (
  id          bigint generated always as identity primary key,
  fonte       text        not null
              check (fonte in ('inmet','cemaden','defesacivil_rj','defesacivil_mun','alertario')),
  id_externo  text,
  severidade  text        check (severidade in
              ('observacao','perigo_potencial','perigo','grande_perigo')),
  evento      text,       -- 'chuva_intensa' | 'vendaval' | 'deslizamento' | 'granizo'
  inicio      timestamptz not null,
  fim         timestamptz,
  municipios  integer[]   not null default '{}',   -- códigos IBGE
  descricao   text,
  bruto       jsonb,
  coletado_em timestamptz not null default now(),
  unique (fonte, id_externo)
);

create index alerta_vigencia_idx on tempo.alerta_oficial (inicio desc, fim);
create index alerta_municipios_idx on tempo.alerta_oficial using gin (municipios);

comment on table tempo.alerta_oficial is
  'Retenção PERMANENTE: baixo volume e é o histórico do que "quase aconteceu".';

-- ============================================================================
-- 5. IMPACTO — verdade de campo e histórico destilado
-- ============================================================================

-- Reporte do usuário: o ativo original do projeto (§10).
-- O usuário vira sensor de um dado que não existe publicamente.
create table tempo.reporte_falta_luz (
  id             bigint generated always as identity primary key,
  municipio_ibge integer     not null,
  bairro         text,
  ocorreu_em     timestamptz not null,
  duracao_min    integer     check (duracao_min is null or duracao_min between 0 and 20160),
  reportado_em   timestamptz not null default now(),
  origem         text        not null default 'usuario'
                 check (origem in ('usuario','aneel','distribuidora')),
  -- anti-abuso leve: hash de sessão/navegador, sem dado pessoal
  fingerprint    text,
  check (ocorreu_em <= now() + interval '1 hour')
);

create index reporte_janela_idx on tempo.reporte_falta_luz (ocorreu_em desc);
create index reporte_municipio_idx on tempo.reporte_falta_luz (municipio_ibge, ocorreu_em desc);

-- Destilado do histórico ANEEL (§9). Preenchido pelo bootstrap externo
-- (Colab/DuckDB), NUNCA pelo runtime — os Parquet originais têm ~200 MB/ano.
create table tempo.impacto_historico (
  id                bigint generated always as identity primary key,
  municipio_ibge    integer not null,
  dia               date    not null,
  n_ocorrencias     integer,
  n_interrupcoes    integer,
  uc_afetadas       integer,
  duracao_media_min real,
  -- "dia crítico" é a definição OFICIAL da ANEEL de evento climático de massa.
  -- É rótulo de catástrofe fornecido pela própria fiscalização.
  dia_critico       boolean not null default false,
  -- decreto de calamidade/emergência vigente (dataset "Evento Situação de Emergência")
  calamidade        boolean not null default false,
  fonte             text    not null default 'aneel',
  unique (municipio_ibge, dia, fonte)
);

create index impacto_dia_idx on tempo.impacto_historico (dia desc);
create index impacto_critico_idx on tempo.impacto_historico (dia_critico) where dia_critico;

comment on table tempo.impacto_historico is
  'Retenção PERMANENTE. É o conjunto de treino da camada de impacto (§9). '
  'Cruzado com ERA5 histórico, produz os limiares empíricos.';

-- ============================================================================
-- 6. VERIFICAÇÃO E SKILL (§5.4 — o que separa isto de um mashup de APIs)
-- ============================================================================

create table tempo.verificacao (
  id            bigint generated always as identity primary key,
  linhagem_id   smallint    not null references tempo.linhagem(id),
  ponto_id      smallint    not null references tempo.ponto(id),
  variavel      text        not null,
  horizonte_h   smallint    not null,
  valido_em     timestamptz not null,
  previsto      real,
  observado     real,
  erro          real generated always as (previsto - observado) stored,
  verificado_em timestamptz not null default now()
);

create index verificacao_agregacao_idx
  on tempo.verificacao (linhagem_id, variavel, horizonte_h);

-- O DESTILADO PERMANENTE. Quando a previsão bruta é apagada, isto sobrevive.
-- "O sistema não precisa lembrar das previsões, precisa lembrar do que
--  aprendeu com elas." (PROJETO.md §6)
create table tempo.skill (
  linhagem_id     smallint        not null references tempo.linhagem(id),
  regiao          tempo.regiao_rj not null,
  variavel        text            not null,
  faixa_horizonte text            not null
                  check (faixa_horizonte in ('0-6h','6-24h','24-72h','72-120h')),
  n_amostras      integer         not null default 0,
  mae             real,        -- erro absoluto médio
  brier           real,        -- calibração probabilística
  vies            real,        -- tendência sistemática (over/under)
  peso            real         not null default 1.0
                  check (peso >= 0),
  atualizado_em   timestamptz  not null default now(),
  primary key (linhagem_id, regiao, variavel, faixa_horizonte)
);

comment on column tempo.skill.peso is
  'Peso na fusão. Deriva de mae/brier — NUNCA de opinião (§5.2). '
  'Enquanto n_amostras for baixo, permanece 1.0 (sem evidência = sem preferência).';

-- ============================================================================
-- 7. GATILHO DE ALERTA — pronto, porém DESARMADO
-- ============================================================================
-- O usuário dispensou alerta por e-mail agora, mas pediu o gatilho pronto.
-- Toda a mecânica existe; nada dispara enquanto ativo = false.

create table tempo.gatilho_alerta (
  id             smallint generated always as identity primary key,
  nome           text        not null unique,
  descricao      text,
  -- expressão SQL booleana avaliada contra a view de risco consolidado
  condicao_sql   text        not null,
  canal          text        not null default 'email'
                 check (canal in ('email','webhook')),
  destino        text,
  -- janela mínima entre disparos, evita enxurrada durante um mesmo evento
  cooldown_min   integer     not null default 180,
  ativo          boolean     not null default false,   -- <<< DESARMADO
  ultimo_disparo timestamptz,
  criado_em      timestamptz not null default now()
);

comment on table tempo.gatilho_alerta is
  'DESARMADO por decisão do usuário (2026-09-10). Para armar: '
  'update tempo.gatilho_alerta set ativo = true, destino = ''...'' where nome = ''...'';';

create table tempo.alerta_disparado (
  id           bigint generated always as identity primary key,
  gatilho_id   smallint    not null references tempo.gatilho_alerta(id),
  disparado_em timestamptz not null default now(),
  payload      jsonb,
  ok           boolean,
  erro         text
);

-- ============================================================================
-- 8. OBSERVABILIDADE
-- ============================================================================

create table tempo.coleta_log (
  id          bigint generated always as identity primary key,
  fonte       text        not null,
  iniciada_em timestamptz not null default now(),
  duracao_ms  integer,
  ok          boolean,
  n_registros integer,
  erro        text
);

create index coleta_log_recente_idx on tempo.coleta_log (iniciada_em desc);

-- ============================================================================
-- 9. RLS — risco R2 do PROJETO.md
-- ----------------------------------------------------------------------------
-- A anon key fica visível no HTML. "Amigo confiável" NÃO substitui RLS.
-- Regra: leitura pública no que é previsão/observação; escrita apenas no
-- reporte de falta de luz; nada mais é exposto ao anon.
-- ============================================================================

alter table tempo.ponto              enable row level security;
alter table tempo.linhagem           enable row level security;
alter table tempo.previsao           enable row level security;
alter table tempo.observacao         enable row level security;
alter table tempo.alerta_oficial     enable row level security;
alter table tempo.reporte_falta_luz  enable row level security;
alter table tempo.impacto_historico  enable row level security;
alter table tempo.verificacao        enable row level security;
alter table tempo.skill              enable row level security;
alter table tempo.gatilho_alerta     enable row level security;
alter table tempo.alerta_disparado   enable row level security;
alter table tempo.coleta_log         enable row level security;

-- Leitura pública (dados científicos, sem PII)
create policy leitura_publica on tempo.ponto             for select to anon, authenticated using (true);
create policy leitura_publica on tempo.linhagem          for select to anon, authenticated using (true);
create policy leitura_publica on tempo.previsao          for select to anon, authenticated using (true);
create policy leitura_publica on tempo.observacao        for select to anon, authenticated using (true);
create policy leitura_publica on tempo.alerta_oficial    for select to anon, authenticated using (true);
create policy leitura_publica on tempo.impacto_historico for select to anon, authenticated using (true);
create policy leitura_publica on tempo.skill             for select to anon, authenticated using (true);

-- Reporte de falta de luz: o anon INSERE, mas não lê os reportes alheios
-- nem edita/apaga o que quer que seja.
create policy reporte_insercao on tempo.reporte_falta_luz
  for insert to anon, authenticated
  with check (
    ocorreu_em >  now() - interval '7 days'
    and ocorreu_em <= now() + interval '1 hour'
    and municipio_ibge between 3300000 and 3399999   -- só RJ
  );

-- verificacao, gatilho_alerta, alerta_disparado, coleta_log:
-- RLS ligada e SEM policy => invisíveis ao anon. Só service_role acessa.

-- ============================================================================
-- 10. RETENÇÃO — a política de esquecimento (§6)
-- ============================================================================

create or replace function tempo.aplicar_retencao()
returns table (tabela text, removidos bigint)
language plpgsql
security definer
set search_path = tempo, pg_catalog
as $$
declare
  n bigint;
begin
  -- Previsão bruta: só serve até ser verificada.
  delete from tempo.previsao where coletada_em < now() - interval '10 days';
  get diagnostics n = row_count;
  tabela := 'previsao'; removidos := n; return next;

  -- Observação: barata e é a verdade. Segura mais tempo.
  delete from tempo.observacao where medido_em < now() - interval '120 days';
  get diagnostics n = row_count;
  tabela := 'observacao'; removidos := n; return next;

  -- Verificação bruta: depois de agregada em skill, não serve mais.
  delete from tempo.verificacao where verificado_em < now() - interval '90 days';
  get diagnostics n = row_count;
  tabela := 'verificacao'; removidos := n; return next;

  delete from tempo.coleta_log where iniciada_em < now() - interval '30 days';
  get diagnostics n = row_count;
  tabela := 'coleta_log'; removidos := n; return next;

  -- alerta_oficial, impacto_historico e skill: PERMANENTES. Nunca apagados.
end;
$$;

comment on function tempo.aplicar_retencao is
  'Executado diariamente por pg_cron. alerta_oficial, impacto_historico e '
  'skill são deliberadamente preservados — são o destilado do projeto.';
