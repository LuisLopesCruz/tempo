-- 117 — QUARENTENA DE PLUVIOMETRO (pedido do usuario, 24/11: "Pode fazer as duas",
-- sobre a proposta de comparar cada municipio com ERA5, ECMWF e vizinhos e tirar
-- quem destoa da verificacao, da calibracao e do aviso de chuva forte).
--
-- Motivo (estudo de 24/11, CEMADEN 11/09-18/11): Mendes marcou 0 mm em 1.608 horas
-- com 417 mm no ERA5, 433 mm no IFS e 313-513 mm nos vizinhos — pluviometro morto,
-- e cada hora dele entrava na verificacao como "nao choveu". Fora os 13 suspeitos,
-- a chance aprendida com 8 de 8 familias prevendo chuva passa de 45% para 52%.
--
-- Como funciona (toda segunda-feira):
--  * 09h30 UTC tempo.qc_pedir(): pede ao Open-Meteo (pg_net, sem custo) a chuva
--    horaria do ERA5 e da analise do ECMWF IFS 9 km nos municipios com CEMADEN,
--    para a janela de 28 dias que termina 7 dias atras (o ERA5 chega com ~6 dias).
--  * 09h40 UTC tempo.qc_avaliar(): soma, nas MESMAS horas com leitura, o medido
--    (media das estacoes, obs_horaria_bruta) e as duas referencias, e da o veredito:
--      baixo  medido < 35% do menor entre ERA5 e IFS (com >= 30 mm na referencia)
--             E < 40% da razao medido/referencia mediana dos vizinhos a ate 40 km
--      alto   medido > 2,2x o maior entre ERA5 e IFS (com >= 60 mm medidos)
--             E > 2x a razao mediana dos vizinhos
--      ok     passou com chuva suficiente para julgar
--      sem_teste  janela seca ou cobertura < 60% das horas: nao muda nada
--    Os vizinhos entram porque o ERA5 tambem erra (no estudo, 24% a mais na media,
--    ate 2x na serra): se os vizinhos medem igualmente pouco, o problema e da
--    reanalise, nao do pluviometro.
--  * baixo/alto abre quarentena (inicio = comeco da janela); ok encerra a aberta
--    (fim = comeco da janela que passou). Historico em tempo.pluviometro_avaliacao.
--
-- O que a quarentena tira: tempo.obs_horaria passa a esconder as horas em
-- quarentena — com isso saem de uma vez a verificacao nova (verificar), o aviso
-- de chuva forte medida, o boletim e o card do municipio ("sem pluviometro com
-- leitura"). Os pares JA gravados ficam no banco e sao filtrados em
-- atualizar_skill e atualizar_calibracao (reversivel: encerrar a quarentena os
-- traz de volta). drivers_dia (risco eletrico do dia) tambem deixa de usar a
-- chuva medida do municipio em quarentena e fica com a prevista.
-- A avaliacao le tempo.obs_horaria_bruta (sem o filtro), senao um pluviometro em
-- quarentena nunca poderia provar que voltou.

create table if not exists tempo.pluviometro_quarentena (
  id           bigserial primary key,
  ponto_id     integer not null references tempo.ponto(id),
  inicio       timestamptz not null,
  fim          timestamptz,
  motivo       text not null check (motivo in ('baixo', 'alto', 'manual')),
  detalhe      jsonb,
  criado_em    timestamptz not null default now(),
  encerrado_em timestamptz
);
create unique index if not exists pluviometro_quarentena_aberta on tempo.pluviometro_quarentena (ponto_id) where fim is null;
create index if not exists pluviometro_quarentena_ponto on tempo.pluviometro_quarentena (ponto_id, inicio);
alter table tempo.pluviometro_quarentena enable row level security;

create table if not exists tempo.pluviometro_avaliacao (
  janela_ini  date not null,
  janela_fim  date not null,
  ponto_id    integer not null references tempo.ponto(id),
  horas       integer,
  obs_mm      real,
  era5_mm     real,
  ifs_mm      real,
  viz_razao   real,
  n_viz       integer,
  veredito    text not null,
  avaliado_em timestamptz not null default now(),
  primary key (janela_fim, ponto_id)
);
alter table tempo.pluviometro_avaliacao enable row level security;

create table if not exists tempo.qc_req (
  lote       integer primary key,
  req        bigint not null,
  ids        integer[] not null,
  janela_ini date not null,
  janela_fim date not null,
  pedido_em  timestamptz not null default now()
);
alter table tempo.qc_req enable row level security;

-- chuva medida SEM o filtro (a definicao do sql/113)
create or replace view tempo.obs_horaria_bruta as
 SELECT o.ponto_id,
    date_trunc('hour'::text, o.medido_em) AS hora,
    avg(o.valor::double precision) AS observado,
    'alerta-rio'::text AS fonte,
    count(*)::integer AS n_estacoes,
    max(o.valor::double precision) AS observado_max
   FROM tempo.observacao o
  WHERE o.variavel = 'precip_1h'::text AND o.ponto_id IS NOT NULL
  GROUP BY o.ponto_id, (date_trunc('hour'::text, o.medido_em))
UNION ALL
 SELECT d.ponto_id,
    (d.dia + make_interval(hours => i.i - 1)) AT TIME ZONE 'America/Sao_Paulo'::text AS hora,
    d.chuva_h[i.i]::double precision AS observado,
    d.fonte,
    d.n_estacoes[i.i]::integer AS n_estacoes,
    d.chuva_h_max[i.i]::double precision AS observado_max
   FROM tempo.observacao_dia d
     CROSS JOIN generate_series(1, 24) i(i)
  WHERE d.chuva_h[i.i] IS NOT NULL;

-- chuva medida que o sistema USA: sem as horas em quarentena
create or replace view tempo.obs_horaria as
 SELECT b.ponto_id, b.hora, b.observado, b.fonte, b.n_estacoes, b.observado_max
   FROM tempo.obs_horaria_bruta b
  WHERE NOT EXISTS (SELECT 1 FROM tempo.pluviometro_quarentena q
                     WHERE q.ponto_id = b.ponto_id AND b.hora >= q.inicio
                       AND (q.fim IS NULL OR b.hora < q.fim));

create or replace function tempo.em_quarentena(p_ponto integer, p_hora timestamptz)
returns boolean language sql stable set search_path = tempo, pg_catalog as $$
  select exists (select 1 from tempo.pluviometro_quarentena q
                  where q.ponto_id = p_ponto and p_hora >= q.inicio and (q.fim is null or p_hora < q.fim))
$$;

create or replace function tempo.qc_pedir(p_ini date default null, p_fim date default null)
returns integer language plpgsql security definer set search_path = tempo, public, pg_catalog as $$
declare
  v_ini date := coalesce(p_ini, (now() at time zone 'America/Sao_Paulo')::date - 35);
  v_fim date := coalesce(p_fim, (now() at time zone 'America/Sao_Paulo')::date - 7);
  n integer;
begin
  delete from tempo.qc_req;
  with pts as (
    select p.id, p.lat, p.lon, (row_number() over (order by p.id) - 1) / 24 as lote
      from tempo.ponto p
     where p.principal
       and exists (select 1 from tempo.observacao_dia d where d.ponto_id = p.id and d.dia between v_ini and v_fim)
  ), l as (
    select lote, array_agg(id order by id) as ids,
           string_agg(round(lat::numeric, 4)::text, ',' order by id) as la,
           string_agg(round(lon::numeric, 4)::text, ',' order by id) as lo
      from pts group by lote
  )
  insert into tempo.qc_req (lote, req, ids, janela_ini, janela_fim)
  select lote,
         net.http_get('https://archive-api.open-meteo.com/v1/archive?latitude=' || la || '&longitude=' || lo
                      || '&start_date=' || v_ini || '&end_date=' || (v_fim + 1)
                      || '&hourly=precipitation&models=era5,ecmwf_ifs&timezone=GMT',
                      timeout_milliseconds := 60000),
         ids, v_ini, v_fim
    from l;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function tempo.qc_avaliar(p_aplicar boolean default true)
returns jsonb language plpgsql security definer set search_path = tempo, public, pg_catalog as $$
declare
  t0 timestamptz := clock_timestamp();
  v_ini date; v_fim date; h_ini timestamptz; h_fim timestamptz;
  v_falta integer; v_abertas integer := 0; v_fechadas integer := 0; v_res jsonb;
begin
  select min(janela_ini), min(janela_fim) into v_ini, v_fim from tempo.qc_req;
  if v_ini is null then return jsonb_build_object('erro', 'nenhum pedido em tempo.qc_req'); end if;
  select count(*) into v_falta
    from tempo.qc_req r left join net._http_response x on x.id = r.req
   where x.id is null or x.status_code is distinct from 200;
  if v_falta > 0 then
    perform public.tempo_log_coleta('qc_pluviometro', (extract(epoch from clock_timestamp() - t0) * 1000)::int, false, 0,
                                    v_falta || ' resposta(s) do Open-Meteo faltando ou com erro');
    return jsonb_build_object('erro', 'respostas faltando', 'n', v_falta);
  end if;
  h_ini := v_ini::timestamp at time zone 'America/Sao_Paulo';
  h_fim := (v_fim + 1)::timestamp at time zone 'America/Sao_Paulo';

  drop table if exists pg_temp.qc_ref;
  create temp table qc_ref on commit drop as
  select r.ids[loc.i::int] as ponto_id, (t.t || 'Z')::timestamptz as hora,
         (loc.v->'hourly'->'precipitation_era5'->>(t.i::int - 1))::real as era5,
         (loc.v->'hourly'->'precipitation_ecmwf_ifs'->>(t.i::int - 1))::real as ifs
    from tempo.qc_req r
    join net._http_response x on x.id = r.req
    cross join lateral jsonb_array_elements(case when jsonb_typeof(x.content::jsonb) = 'array' then x.content::jsonb
                                                 else jsonb_build_array(x.content::jsonb) end) with ordinality loc(v, i)
    cross join lateral jsonb_array_elements_text(loc.v->'hourly'->'time') with ordinality t(t, i);

  delete from tempo.pluviometro_avaliacao where janela_fim = v_fim;
  with o as (
    select b.ponto_id, b.observado as obs, q.era5, q.ifs
      from tempo.obs_horaria_bruta b
      join qc_ref q on q.ponto_id = b.ponto_id and q.hora = b.hora
     where b.fonte = 'cemaden' and b.hora >= h_ini and b.hora < h_fim and b.observado <= 120
       and q.era5 is not null and q.ifs is not null
  ), pm as (
    select ponto_id, count(*)::int as horas, sum(obs) as obs, sum(era5) as era5, sum(ifs) as ifs from o group by 1
  ), pre as (
    select pm.*, p.lat, p.lon, pm.obs / nullif((pm.era5 + pm.ifs) / 2, 0) as razao,
           case when pm.horas < 0.6 * extract(epoch from h_fim - h_ini) / 3600 then 'sem_teste'
                when pm.obs < 0.35 * least(pm.era5, pm.ifs) and least(pm.era5, pm.ifs) >= 30 then 'baixo'
                when pm.obs > 2.2 * greatest(pm.era5, pm.ifs) and pm.obs >= 60 then 'alto'
                when least(pm.era5, pm.ifs) >= 30 or pm.obs >= 30 then 'ok'
                else 'sem_teste' end as v0
      from pm join tempo.ponto p on p.id = pm.ponto_id
  ), viz as (
    select a.ponto_id, percentile_cont(0.5) within group (order by n.razao) as viz_razao, count(*)::int as n_viz
      from pre a join pre n on n.ponto_id <> a.ponto_id and n.v0 = 'ok' and n.razao is not null
       and 6371 * 2 * asin(sqrt(power(sin(radians(n.lat - a.lat) / 2), 2)
             + cos(radians(a.lat)) * cos(radians(n.lat)) * power(sin(radians(n.lon - a.lon) / 2), 2))) <= 40
     group by 1
  )
  insert into tempo.pluviometro_avaliacao (janela_ini, janela_fim, ponto_id, horas, obs_mm, era5_mm, ifs_mm, viz_razao, n_viz, veredito)
  select v_ini, v_fim, pre.ponto_id, pre.horas, pre.obs, pre.era5, pre.ifs, viz.viz_razao, coalesce(viz.n_viz, 0),
         case when pre.v0 = 'baixo' and (viz.viz_razao is null or pre.razao < 0.4 * viz.viz_razao) then 'baixo'
              when pre.v0 = 'alto'  and (viz.viz_razao is null or pre.razao > 2.0 * viz.viz_razao) then 'alto'
              when pre.v0 in ('baixo', 'alto') then 'ok'   -- os vizinhos medem o mesmo: o erro e da reanalise
              else pre.v0 end
    from pre left join viz on viz.ponto_id = pre.ponto_id;

  if p_aplicar then
    with novos as (
      insert into tempo.pluviometro_quarentena (ponto_id, inicio, motivo, detalhe)
      select a.ponto_id, h_ini, a.veredito,
             jsonb_build_object('janela', v_ini || ' a ' || v_fim, 'medido_mm', round(a.obs_mm::numeric, 1),
                                'era5_mm', round(a.era5_mm::numeric, 1), 'ifs_mm', round(a.ifs_mm::numeric, 1),
                                'viz_razao', round(a.viz_razao::numeric, 2), 'n_viz', a.n_viz)
        from tempo.pluviometro_avaliacao a
       where a.janela_fim = v_fim and a.veredito in ('baixo', 'alto')
         and not exists (select 1 from tempo.pluviometro_quarentena q where q.ponto_id = a.ponto_id and q.fim is null)
      returning 1
    ) select count(*) into v_abertas from novos;
    with sai as (
      update tempo.pluviometro_quarentena q set fim = greatest(q.inicio, h_ini), encerrado_em = now()
        from tempo.pluviometro_avaliacao a
       where a.janela_fim = v_fim and a.veredito = 'ok' and a.ponto_id = q.ponto_id and q.fim is null
      returning 1
    ) select count(*) into v_fechadas from sai;
  end if;

  select jsonb_build_object('janela', v_ini || ' a ' || v_fim, 'aplicado', p_aplicar,
           'avaliados', count(*), 'abertas', v_abertas, 'encerradas', v_fechadas,
           'por_veredito', (select jsonb_object_agg(veredito, n) from (select veredito, count(*) n from tempo.pluviometro_avaliacao
                                                                         where janela_fim = v_fim group by 1) z),
           'suspeitos', (select jsonb_agg(jsonb_build_object('municipio', p.municipio, 'veredito', a.veredito,
                                   'medido', round(a.obs_mm::numeric), 'era5', round(a.era5_mm::numeric), 'ifs', round(a.ifs_mm::numeric),
                                   'viz_razao', round(a.viz_razao::numeric, 2), 'n_viz', a.n_viz) order by p.municipio)
                           from tempo.pluviometro_avaliacao a join tempo.ponto p on p.id = a.ponto_id
                          where a.janela_fim = v_fim and a.veredito in ('baixo', 'alto')),
           'em_quarentena', (select jsonb_agg(p.municipio order by p.municipio) from tempo.pluviometro_quarentena q
                               join tempo.ponto p on p.id = q.ponto_id where q.fim is null))
    into v_res
    from tempo.pluviometro_avaliacao where janela_fim = v_fim;
  if p_aplicar then
    perform public.tempo_log_coleta('qc_pluviometro', (extract(epoch from clock_timestamp() - t0) * 1000)::int, true,
                                    (v_res->>'avaliados')::int, null);
  end if;
  return v_res;
end $$;

revoke all on function tempo.qc_pedir(date, date) from public, anon, authenticated;
revoke all on function tempo.qc_avaliar(boolean) from public, anon, authenticated;

-- pesos: pares gravados durante uma quarentena nao contam
create or replace function tempo.atualizar_skill(p_min_amostras integer default 30, p_min_horas integer default 72)
 returns integer language plpgsql security definer set search_path to 'tempo', 'public', 'pg_catalog' as $function$
declare n integer;
begin
  with agg as (
    select v.linhagem_id, pt.regiao, v.variavel,
           case when v.horizonte_h <=  6 then '0-6h'
                when v.horizonte_h <= 24 then '6-24h'
                when v.horizonte_h <= 72 then '24-72h'
                else '72-120h' end as faixa,
           count(*)                                            as n_amostras,
           count(distinct date_trunc('hour', v.valido_em))      as n_horas,
           avg(abs(v.erro))                                     as mae,
           avg(v.erro)                                          as vies
    from tempo.verificacao v
    join tempo.ponto pt on pt.id = v.ponto_id
    where not exists (select 1 from tempo.pluviometro_quarentena q
                       where q.ponto_id = v.ponto_id and v.valido_em >= q.inicio and (q.fim is null or v.valido_em < q.fim))
    group by 1, 2, 3, 4
  ),
  -- normaliza dentro do grupo comparavel: um modelo so compete com os outros
  -- na MESMA regiao, variavel e faixa de horizonte.
  comp as (
    select a.*, min(a.mae) over (partition by a.regiao, a.variavel, a.faixa) as melhor_mae
    from agg a
  )
  insert into tempo.skill (linhagem_id, regiao, variavel, faixa_horizonte,
                           n_amostras, n_horas, mae, vies, peso, atualizado_em)
  select linhagem_id, regiao, variavel, faixa, n_amostras, n_horas, mae, vies,
         case when n_amostras < p_min_amostras then 1.0
              when n_horas    < p_min_horas    then 1.0   -- amostra larga mas curta: nao decide nada
              when mae is null or mae <= 0 then 1.0
              -- peso relativo ao melhor do grupo, piso em 0.25 para nunca
              -- silenciar por completo uma linhagem (ela pode acertar o evento raro)
              else greatest(0.25, (coalesce(melhor_mae, mae) + 0.1) / (mae + 0.1))
         end,
         now()
  from comp
  on conflict (linhagem_id, regiao, variavel, faixa_horizonte) do update
    set n_amostras = excluded.n_amostras, n_horas = excluded.n_horas,
        mae = excluded.mae, vies = excluded.vies,
        peso = excluded.peso, atualizado_em = now();
  get diagnostics n = row_count;
  return n;
end;
$function$;

-- calibracao da chance de chuva: idem
create or replace function tempo.atualizar_calibracao()
 returns integer language plpgsql security definer set search_path to 'tempo', 'public', 'pg_catalog' as $function$
declare linhas integer;
begin
  delete from tempo.calibracao
   where variavel in ('precip_1h','chuva_6h','chuva_dia_D0','chuva_dia_D12','chuva_dia_D34');

  with u as (
    select distinct on (valido_em, ponto_id, linhagem_id)
           valido_em, ponto_id, linhagem_id, previsto, observado
      from tempo.verificacao v
     where variavel = 'precip_1h'
       and not exists (select 1 from tempo.pluviometro_quarentena q
                        where q.ponto_id = v.ponto_id and v.valido_em >= q.inicio and (q.fim is null or v.valido_em < q.fim))
     order by valido_em, ponto_id, linhagem_id, horizonte_h asc
  ),
  h as (
    select valido_em, ponto_id, count(*) as familias,
           count(*) filter (where previsto >= 0.5) as k,
           case when max(observado) >= 0.5 then 1.0 else 0.0 end as ocorreu
      from u group by 1, 2
  )
  insert into tempo.calibracao (faixa_prob, variavel, n_previsoes, prob_media, freq_observada, brier, atualizado)
  select 'k' || k, 'precip_1h', count(*), k / 8.0, avg(ocorreu),
         avg(power(k / 8.0 - ocorreu, 2)), now()
    from h where familias = 8
   group by k;
  get diagnostics linhas = row_count;
  return linhas;
end;
$function$;

-- cron semanal (segunda): pedir 09h30 UTC, avaliar 09h40 UTC
select cron.schedule('tempo_qc_pedir', '30 9 * * 1', 'select tempo.qc_pedir();');
select cron.schedule('tempo_qc_avaliar', '40 9 * * 1', 'select tempo.qc_avaliar();');

-- risco eletrico do dia (drivers_dia): a chuva medida de municipio em quarentena
-- nao substitui a prevista. Edita so o filtro de hora_obs da definicao viva.
do $$
declare d text := pg_get_viewdef('tempo.drivers_dia'::regclass, true);
        velho text := 'WHERE o.chuva_h_med[i.i] IS NOT NULL';
        novo text := 'WHERE o.chuva_h_med[i.i] IS NOT NULL AND NOT tempo.em_quarentena(o.ponto_id, (o.dia + make_interval(hours => i.i - 1)) AT TIME ZONE ''America/Sao_Paulo''::text)';
begin
  if position('em_quarentena' in d) > 0 then return; end if;
  if position(velho in d) = 0 then raise exception 'drivers_dia: filtro de hora_obs nao encontrado'; end if;
  execute 'create or replace view tempo.drivers_dia as ' || replace(d, velho, novo);
end $$;
