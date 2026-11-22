-- 110 — Ceu e tempestade do painel passam a ser APRENDIDOS com observacao
-- (pedido do usuario, 22/11: "sol, tempestade e noite limpa nunca aparecem";
-- em Sao Pedro da Aldeia, ceu azul). "Pode fazer."
--
-- Diagnostico (22/11): a mediana da cobertura TOTAL de nuvem dos 8 modelos dava
-- 81-96% com METAR "FEW" (1-2/8) em todos os aeroportos do RJ; nos 5 dias
-- seguintes nenhuma hora do estado ficava abaixo de 40%. Culpa das nuvens
-- ALTAS: ECMWF, GFS, ARPEGE e JMA davam 77-100% de alta e 0-20% de baixa+media.
-- E a "tempestade" exigia chance de chuva forte >= 50% ou mediana >= 15 mm/h:
-- o maximo do estado nos 5 dias era 24% e 7 mm/h. Nenhum dos dois cortes foi
-- medido; os dois eram inalcancaveis.
--
-- O que muda:
--  1. nuvem VISIVEL (max de baixa e media, por modelo; o coletor grava
--     'nuvem_vis' no blob) entra em previsao_horaria/consolidado/tempo_previsao.
--  2. METAR de 9 aeroportos do RJ, de hora em hora (REDEMET), em nuvem_obs:
--     cobertura observada e trovoada (TS/CB). Cada observacao e pareada com a
--     previsao da mesma hora.
--  3. trovoada_par: para os 92 municipios, de hora em hora, a previsao (energia
--     para tempestade e chance de chuva) e, depois, se houve celula da REDEMET a
--     ate 10 km na hora.
--  4. ceu_calibrar() (diario): os cortes sol/parcial/nublado/encoberto saem do
--     pareamento por quantis (a previsao passa a ter a mesma frequencia de cada
--     categoria que o ceu observado); a chance de trovoada de cada faixa
--     (energia x chance de chuva) e a frequencia observada, encolhida para uma
--     chance inicial enquanto houver poucos casos.
--  5. tempo_previsao ganha nuvem_vis, ceu, p_trovoada e trovoada; o painel so
--     desenha.

-- ------------------------------------------------------------------ 1. nuvem visivel
create or replace view tempo.previsao_horaria as
 WITH ultima AS (
         SELECT DISTINCT ON (p.ponto_id, p.linhagem_id) p.ponto_id, p.linhagem_id, p.emitida_em,
            p.inicio_serie, p.passo_horas, p.dados
           FROM tempo.previsao p
          WHERE p.coletada_em > (now() - '2 days'::interval)
          ORDER BY p.ponto_id, p.linhagem_id, p.emitida_em DESC
        )
 SELECT u.ponto_id, u.linhagem_id, u.emitida_em,
    u.inicio_serie + (((i.i - 1) * u.passo_horas)::double precision * '01:00:00'::interval) AS valido_em,
    ((u.dados -> 'precip_mm') ->> (i.i - 1))::real AS precip_mm,
    ((u.dados -> 'rajada_kmh') ->> (i.i - 1))::real AS rajada_kmh,
    ((u.dados -> 'vento_kmh') ->> (i.i - 1))::real AS vento_kmh,
    ((u.dados -> 'temp_c') ->> (i.i - 1))::real AS temp_c,
    ((u.dados -> 'umid_pct') ->> (i.i - 1))::real AS umid_pct,
    ((u.dados -> 'cape') ->> (i.i - 1))::real AS cape,
    ((u.dados -> 'nuvem_pct') ->> (i.i - 1))::real AS nuvem_pct,
    ((u.dados -> 'nuvem_vis') ->> (i.i - 1))::real AS nuvem_vis
   FROM ultima u, LATERAL generate_series(1, jsonb_array_length(u.dados -> 'precip_mm')) i(i);

create or replace view tempo.consolidado as
 WITH base AS (
         SELECT ph.ponto_id, ph.valido_em, ph.linhagem_id, l.familia, ph.precip_mm, ph.rajada_kmh, ph.temp_c,
            ph.cape, ph.nuvem_pct,
            (GREATEST(0::numeric, round(EXTRACT(epoch FROM ph.valido_em - now()) / 3600::numeric)))::integer AS horiz,
            pt.regiao, ph.nuvem_vis
           FROM tempo.previsao_horaria ph
             JOIN tempo.linhagem l ON l.id = ph.linhagem_id
             JOIN tempo.ponto pt ON pt.id = ph.ponto_id
        ), comp AS (
         SELECT b.ponto_id, b.valido_em, b.linhagem_id, b.familia, b.precip_mm, b.rajada_kmh, b.temp_c, b.cape,
            b.nuvem_pct, b.horiz, b.regiao,
            COALESCE(s.peso, 1.0::real) AS peso,
            COALESCE(s.n_amostras, 0) AS n_amostras,
            b.nuvem_vis
           FROM base b
             LEFT JOIN tempo.skill s ON s.linhagem_id = b.linhagem_id AND s.regiao = b.regiao
                AND s.variavel = 'precip_1h'::text
                AND s.faixa_horizonte = CASE WHEN b.horiz <= 6 THEN '0-6h'::text WHEN b.horiz <= 24 THEN '6-24h'::text
                                             WHEN b.horiz <= 72 THEN '24-72h'::text ELSE '72-120h'::text END
        ), fam AS (
         SELECT comp.ponto_id, comp.valido_em, comp.familia,
            avg(comp.peso) AS peso,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY comp.precip_mm::double precision) AS precip,
            max(comp.rajada_kmh) AS rajada,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY comp.temp_c::double precision) AS temp,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY comp.cape::double precision) AS cape,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY comp.nuvem_pct::double precision) AS nuvem,
            count(*) AS n_linhagens,
            max(comp.n_amostras) AS n_amostras,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY comp.nuvem_vis::double precision) AS nuvem_vis
           FROM comp
          GROUP BY comp.ponto_id, comp.valido_em, comp.familia
        )
 SELECT ponto_id, valido_em,
    round(EXTRACT(epoch FROM valido_em - now()) / 3600::numeric)::integer AS horizonte_h,
    sum(n_linhagens)::integer AS n_linhagens,
    count(*)::integer AS n_familias,
    max(n_amostras) AS skill_amostras,
    round(COALESCE(stddev_pop(peso), 0::double precision)::numeric, 3) AS skill_dispersao_peso,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY precip) AS precip_mediana,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY precip) AS precip_p25,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY precip) AS precip_p75,
    min(precip) AS precip_min,
    max(precip) AS precip_max,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY rajada::double precision) AS rajada_p75,
    max(rajada) AS rajada_max,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY temp) AS temp_mediana,
    (sum(peso) FILTER (WHERE precip >= 0.5::double precision) / NULLIF(sum(peso), 0::double precision))::real AS prob_chuva,
    (sum(peso) FILTER (WHERE precip >= 5.0::double precision) / NULLIF(sum(peso), 0::double precision))::real AS prob_chuva_moderada,
    (sum(peso) FILTER (WHERE precip >= 15.0::double precision) / NULLIF(sum(peso), 0::double precision))::real AS prob_chuva_forte,
    (sum(peso) FILTER (WHERE rajada >= 60::double precision) / NULLIF(sum(peso), 0::double precision))::real AS prob_vendaval,
    (count(*) FILTER (WHERE precip >= 15.0::double precision))::integer AS familias_chuva_forte,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY cape) AS cape_mediana,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY nuvem) AS nuvem_mediana,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY nuvem_vis) AS nuvem_vis_mediana
   FROM fam f
  GROUP BY ponto_id, valido_em;

-- ------------------------------------------------------------------ 2. parametros
create table if not exists tempo.ceu_param (
  chave text primary key, valor real not null, nota text, atualizado_em timestamptz not null default now()
);
insert into tempo.ceu_param (chave, valor, nota) values
  ('corte_parcial',   20, 'nuvem visivel (%) a partir da qual o ceu deixa de ser "sol"; provisorio ate haver pares'),
  ('corte_nublado',   50, 'idem, "nublado"'),
  ('corte_encoberto', 85, 'idem, "encoberto"'),
  ('min_pares',      200, 'pares METAR x previsao para trocar os cortes provisorios pelos aprendidos'),
  ('limiar_trovoada', 0.30, 'chance de trovoada a partir da qual a hora vira "tempestade" no painel'),
  ('peso_prior',      30, 'casos equivalentes da chance inicial de cada faixa de trovoada'),
  ('n_pares',          0, 'pares usados na ultima calibracao do ceu')
on conflict (chave) do nothing;
alter table tempo.ceu_param enable row level security;

-- Faixas de trovoada: energia para tempestade (CAPE mediana) x chance de chuva.
-- A chance inicial e conservadora: so energia alta COM chuva provavel passa
-- do limiar antes de haver dados.
create table if not exists tempo.trovoada_faixa (
  cape_faixa  smallint not null,   -- 0: <250  1: 250-1000  2: 1000-2000  3: >=2000 J/kg
  chuva_faixa smallint not null,   -- 0: <25%  1: 25-50%    2: 50-75%     3: >=75%
  prior real not null, n integer not null default 0, sim integer not null default 0, p real not null,
  primary key (cape_faixa, chuva_faixa)
);
insert into tempo.trovoada_faixa (cape_faixa, chuva_faixa, prior, p)
select c, r, pr, pr from (
  select c, r, case when c >= 2 and r >= 2 then 0.40 when c >= 2 and r = 1 then 0.20
                    when c = 1 and r >= 2 then 0.15 when c >= 1 then 0.06 else 0.02 end::real as pr
    from generate_series(0, 3) c, generate_series(0, 3) r) x
on conflict do nothing;
alter table tempo.trovoada_faixa enable row level security;

create or replace function tempo.faixa_cape(v double precision) returns smallint language sql immutable as $$
  select case when v is null or v < 250 then 0 when v < 1000 then 1 when v < 2000 then 2 else 3 end::smallint $$;
create or replace function tempo.faixa_chuva(v double precision) returns smallint language sql immutable as $$
  select case when v is null or v < 0.25 then 0 when v < 0.5 then 1 when v < 0.75 then 2 else 3 end::smallint $$;

-- ------------------------------------------------------------------ 3. METAR
create table if not exists tempo.metar_estacao (
  icao text primary key, municipio_ibge integer not null, nome text
);
insert into tempo.metar_estacao values
  ('SBES', 3305208, 'São Pedro da Aldeia'), ('SBCB', 3300704, 'Cabo Frio'), ('SBME', 3302403, 'Macaé'),
  ('SBCP', 3301009, 'Campos dos Goytacazes'), ('SBRJ', 3304557, 'Rio (Santos Dumont)'),
  ('SBGL', 3304557, 'Rio (Galeão)'), ('SBJR', 3304557, 'Rio (Jacarepaguá)'),
  ('SBAF', 3304557, 'Rio (Afonsos)'), ('SBSC', 3304557, 'Rio (Santa Cruz)')
on conflict (icao) do nothing;
alter table tempo.metar_estacao enable row level security;

create table if not exists tempo.nuvem_obs (
  icao text not null, hora timestamptz not null,
  cobertura smallint,          -- maior camada: 0 (CAVOK/NSC) 19 (FEW) 44 (SCT) 75 (BKN) 100 (OVC/VV)
  categoria text,              -- sol | parcial | nublado | encoberto
  trovoada boolean not null default false,   -- TS no tempo presente ou CB na nuvem
  metar text,
  prev_vis real, prev_total real,            -- previsao (mediana) da mesma hora, no municipio
  primary key (icao, hora)
);
alter table tempo.nuvem_obs enable row level security;

create table if not exists tempo.metar_req (id bigint primary key, pedido_em timestamptz not null default now(), lido boolean not null default false);
alter table tempo.metar_req enable row level security;

create or replace function tempo.metar_disparar() returns bigint
language plpgsql security definer set search_path = tempo, public, pg_catalog as $$
declare v_id bigint;
begin
  select net.http_get(
    url := 'https://api-redemet.decea.mil.br/mensagens/metar/' ||
           (select string_agg(icao, ',' order by icao) from tempo.metar_estacao) ||
           '?data_ini=' || to_char((now() at time zone 'UTC') - interval '3 hours', 'YYYYMMDDHH24') ||
           '&data_fim=' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24'),
    headers := jsonb_build_object('X-Api-Key', (select valor from tempo.config where chave = 'redemet_chave')),
    timeout_milliseconds := 30000) into v_id;
  insert into tempo.metar_req (id) values (v_id);
  delete from tempo.metar_req where pedido_em < now() - interval '2 days';
  return v_id;
end $$;

-- Le os METAR pedidos, grava a cobertura observada e pareia com a previsao.
create or replace function tempo.metar_coletar() returns integer
language plpgsql security definer set search_path = tempo, public, pg_catalog as $$
declare n integer := 0; v_ids bigint[];
begin
  select array_agg(q.id) into v_ids
    from tempo.metar_req q join net._http_response r on r.id = q.id where not q.lido;
  with resp as (
    select r.id, x->>'mens' as mens, x->>'validade_inicial' as validade
      from net._http_response r
      cross join lateral jsonb_array_elements(coalesce((r.content::jsonb)->'data'->'data', '[]')) x
     where r.id = any(v_ids) and r.status_code = 200
  ), m as (
    select substring(mens from '^METAR (?:COR )?([A-Z]{4}) ') as icao, validade, mens
      from resp where mens like 'METAR %'          -- SPECI fica de fora: so a hora cheia
  ), c as (
    select m.icao, m.mens,
           date_trunc('hour', m.validade::timestamp) as hora_utc,   -- a REDEMET da a hora em UTC
           case
             when m.mens ~ '\m(OVC|VV)\d{3}' then 100
             when m.mens ~ '\mBKN\d{3}' then 75
             when m.mens ~ '\mSCT\d{3}' then 44
             when m.mens ~ '\mFEW\d{3}' then 19
             when m.mens ~ '\m(CAVOK|NSC|NCD|SKC|CLR)\M' then 0
           end::smallint as cob,
           (m.mens ~ ' (\+|-|VC)?TS' or m.mens ~ '\d{3}CB\M') as tro
      from m where m.icao is not null and m.validade is not null
  ), ins as (
    insert into tempo.nuvem_obs (icao, hora, cobertura, categoria, trovoada, metar)
    select c.icao, (c.hora_utc at time zone 'UTC'), c.cob,
           case when c.cob is null then null when c.cob <= 19 then 'sol' when c.cob <= 44 then 'parcial'
                when c.cob <= 75 then 'nublado' else 'encoberto' end,
           c.tro, c.mens
      from c join tempo.metar_estacao e using (icao)
    on conflict (icao, hora) do update set cobertura = excluded.cobertura, categoria = excluded.categoria,
                                           trovoada = excluded.trovoada, metar = excluded.metar
    returning 1
  )
  select count(*) into n from ins;
  -- so marca como lido o que tinha resposta ANTES deste processamento (a
  -- resposta pode chegar no meio dele: no teste de 22/11 chegou, e o pedido foi
  -- marcado lido sem ter sido lido)
  update tempo.metar_req q set lido = true
   where not q.lido and q.id = any(v_ids);
  -- pareia com a previsao da mesma hora (a consolidada ainda cobre ate 1 h atras)
  update tempo.nuvem_obs o set prev_vis = c.nuvem_vis_mediana, prev_total = c.nuvem_mediana
    from tempo.metar_estacao e
    join tempo.ponto p on p.municipio_ibge = e.municipio_ibge and p.principal
    join tempo.consolidado c on c.ponto_id = p.id
   where o.icao = e.icao and c.valido_em = o.hora and o.prev_total is null
     and o.hora >= now() - interval '1 hour';
  return n;
end $$;

-- ------------------------------------------------------------------ 4. pares de trovoada
create table if not exists tempo.trovoada_par (
  ponto_id smallint not null, hora timestamptz not null,
  cape real, prob_chuva real, precip real,
  trovoada boolean,            -- celula da REDEMET a ate 10 km na hora (null = sem leitura)
  primary key (ponto_id, hora)
);
alter table tempo.trovoada_par enable row level security;

create or replace function tempo.trovoada_par_registrar() returns integer
language plpgsql security definer set search_path = tempo, public, pg_catalog as $$
declare n integer;
begin
  -- previsao da hora corrente, para os 92 municipios
  insert into tempo.trovoada_par (ponto_id, hora, cape, prob_chuva, precip)
  select c.ponto_id, c.valido_em, c.cape_mediana, c.prob_chuva, c.precip_mediana
    from tempo.consolidado c
   where c.valido_em = date_trunc('hour', now())
  on conflict do nothing;
  get diagnostics n = row_count;
  -- desfecho das horas ja encerradas (so com leitura da REDEMET na hora)
  update tempo.trovoada_par t set trovoada = exists (
      select 1 from tempo.trovoada_quadro q cross join lateral unnest(q.la, q.lo) c(la, lo)
       where q.quadro >= t.hora - interval '30 minutes' and q.quadro < t.hora + interval '30 minutes'
         and sqrt(power((c.lo - p.lon) * 111.32 * cos(radians(-22.0)), 2) + power((c.la - p.lat) * 110.57, 2)) <= 10)
    from tempo.ponto p
   where p.id = t.ponto_id and p.principal and t.trovoada is null
     and t.hora < now() - interval '45 minutes' and t.hora > now() - interval '1 day'
     and exists (select 1 from tempo.trovoada_quadro q
                  where q.quadro >= t.hora - interval '30 minutes' and q.quadro < t.hora + interval '30 minutes');
  return n;
end $$;

-- ------------------------------------------------------------------ 5. calibracao diaria
create or replace function tempo.ceu_calibrar() returns jsonb
language plpgsql security definer set search_path = tempo, public, pg_catalog as $$
declare
  v_n integer; v_min real := (select valor from tempo.ceu_param where chave = 'min_pares');
  f1 double precision; f2 double precision; f3 double precision;
  c1 real; c2 real; c3 real;
  v_k real := (select valor from tempo.ceu_param where chave = 'peso_prior');
begin
  -- ceu: mapeamento por quantis, so com pares que tem previsao visivel
  select count(*),
         avg((categoria = 'sol')::int), avg((categoria in ('sol', 'parcial'))::int),
         avg((categoria in ('sol', 'parcial', 'nublado'))::int)
    into v_n, f1, f2, f3
    from tempo.nuvem_obs where prev_vis is not null and categoria is not null and hora > now() - interval '60 days';
  update tempo.ceu_param set valor = v_n, atualizado_em = now() where chave = 'n_pares';
  if v_n >= v_min then
    select percentile_cont(f1) within group (order by prev_vis), percentile_cont(f2) within group (order by prev_vis),
           percentile_cont(f3) within group (order by prev_vis)
      into c1, c2, c3
      from tempo.nuvem_obs where prev_vis is not null and categoria is not null and hora > now() - interval '60 days';
    -- cortes coerentes: crescentes, com pelo menos 5 pontos entre eles
    c1 := greatest(1, least(c1, 90)); c2 := greatest(c1 + 5, least(c2, 95)); c3 := greatest(c2 + 5, least(c3, 100));
    update tempo.ceu_param set valor = c1, atualizado_em = now() where chave = 'corte_parcial';
    update tempo.ceu_param set valor = c2, atualizado_em = now() where chave = 'corte_nublado';
    update tempo.ceu_param set valor = c3, atualizado_em = now() where chave = 'corte_encoberto';
  end if;
  -- trovoada: frequencia observada por faixa, encolhida para a chance inicial
  update tempo.trovoada_faixa f set n = coalesce(o.n, 0), sim = coalesce(o.sim, 0),
         p = ((coalesce(o.sim, 0) + v_k * f.prior) / (coalesce(o.n, 0) + v_k))::real
    from (select f2.cape_faixa, f2.chuva_faixa, o.n, o.sim
            from tempo.trovoada_faixa f2
            left join (select tempo.faixa_cape(cape) cf, tempo.faixa_chuva(prob_chuva) rf,
                              count(*) n, count(*) filter (where trovoada) sim
                         from tempo.trovoada_par where trovoada is not null and hora > now() - interval '90 days'
                        group by 1, 2) o on o.cf = f2.cape_faixa and o.rf = f2.chuva_faixa) o
   where f.cape_faixa = o.cape_faixa and f.chuva_faixa = o.chuva_faixa;
  delete from tempo.nuvem_obs where hora < now() - interval '180 days';
  delete from tempo.trovoada_par where hora < now() - interval '120 days';
  return jsonb_build_object('pares_ceu', v_n, 'aprendido', v_n >= v_min,
    'cortes', (select jsonb_object_agg(chave, round(valor::numeric, 1)) from tempo.ceu_param where chave like 'corte_%'));
end $$;

-- ------------------------------------------------------------------ 6. o que o painel le
create or replace view public.tempo_previsao as
 SELECT c.ponto_id, p.municipio_ibge, p.municipio, p.regiao::text AS regiao, c.valido_em, c.horizonte_h,
    c.n_linhagens, c.n_familias, c.skill_amostras, c.skill_dispersao_peso,
    round(c.precip_mediana::numeric, 1) AS precip_mediana,
    round(c.precip_p25::numeric, 1) AS precip_p25,
    round(c.precip_p75::numeric, 1) AS precip_p75,
    round(c.precip_max::numeric, 1) AS precip_max,
    round(c.rajada_p75::numeric, 0) AS rajada_p75,
    round(c.rajada_max::numeric, 0) AS rajada_max,
    round(c.temp_mediana::numeric, 1) AS temp_mediana,
    round(c.prob_chuva::numeric, 2) AS prob_chuva,
    round(c.prob_chuva_moderada::numeric, 2) AS prob_chuva_moderada,
    round(c.prob_chuva_forte::numeric, 2) AS prob_chuva_forte,
    round(c.prob_vendaval::numeric, 2) AS prob_vendaval,
    round((c.precip_p75 - c.precip_p25)::numeric, 1) AS dispersao_precip,
    round(c.nuvem_mediana::numeric, 0) AS nuvem_pct,
    round(c.nuvem_vis_mediana::numeric, 0) AS nuvem_vis,
    -- ceu com os cortes aprendidos; sem nuvem visivel (emissao antiga), cai na total
    case when coalesce(c.nuvem_vis_mediana, c.nuvem_mediana) is null then null
         when coalesce(c.nuvem_vis_mediana, c.nuvem_mediana) >= k.enc then 'encoberto'
         when coalesce(c.nuvem_vis_mediana, c.nuvem_mediana) >= k.nub then 'nublado'
         when coalesce(c.nuvem_vis_mediana, c.nuvem_mediana) >= k.par then 'parcial'
         else 'sol' end AS ceu,
    round(tf.p::numeric, 2) AS p_trovoada,
    (tf.p >= k.lim) AS trovoada
   FROM tempo.consolidado c
     JOIN tempo.ponto p ON p.id = c.ponto_id
     CROSS JOIN (select max(valor) filter (where chave = 'corte_parcial') par,
                        max(valor) filter (where chave = 'corte_nublado') nub,
                        max(valor) filter (where chave = 'corte_encoberto') enc,
                        max(valor) filter (where chave = 'limiar_trovoada') lim
                   from tempo.ceu_param) k
     -- faixas escritas por extenso (e nao com tempo.faixa_*): a view e lida pelo
     -- anon, que precisaria de EXECUTE nas funcoes do esquema tempo
     LEFT JOIN tempo.trovoada_faixa tf
       ON tf.cape_faixa = (case when c.cape_mediana is null or c.cape_mediana < 250 then 0
                                when c.cape_mediana < 1000 then 1 when c.cape_mediana < 2000 then 2 else 3 end)
      AND tf.chuva_faixa = (case when c.prob_chuva is null or c.prob_chuva < 0.25 then 0
                                 when c.prob_chuva < 0.5 then 1 when c.prob_chuva < 0.75 then 2 else 3 end)
  WHERE c.valido_em >= (now() - '01:00:00'::interval) AND c.valido_em <= (now() + '5 days'::interval);

-- leitura do aprendizado (para conferir a calibracao)
create or replace view tempo.ceu_desempenho as
select icao, categoria as observado,
       case when prev_vis >= (select valor from tempo.ceu_param where chave = 'corte_encoberto') then 'encoberto'
            when prev_vis >= (select valor from tempo.ceu_param where chave = 'corte_nublado') then 'nublado'
            when prev_vis >= (select valor from tempo.ceu_param where chave = 'corte_parcial') then 'parcial'
            else 'sol' end as previsto,
       count(*) as horas
  from tempo.nuvem_obs where prev_vis is not null and categoria is not null
 group by 1, 2, 3 order by 1, 2, 3;

-- ------------------------------------------------------------------ 7. agenda
select cron.schedule('tempo_metar_disparar', '7 * * * *', 'select tempo.metar_disparar();');
select cron.schedule('tempo_metar_coletar', '11 * * * *', 'select tempo.metar_coletar(); select tempo.trovoada_par_registrar();');
select cron.schedule('tempo_ceu_calibrar', '55 4 * * *', 'select tempo.ceu_calibrar();');
