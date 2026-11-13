-- 101 — Aviso de trovoada: regra nova + APRENDIZADO (D17, pedido do usuario 13/11)
--
-- REGRA NOVA. "a_caminho" passa a significar "trovoada a 10-30 km nos ultimos
-- 20 min", sem exigir aproximacao e sem horario de chegada. A aproximacao media
-- celula NOVA nascendo mais perto, nao movimento: acertava 38% por municipio,
-- contra 50% do criterio de 30 km (backtest de 34 dias, 92 municipios).
--
-- APRENDIZADO. Cada inicio de episodio (municipio entra em a_caminho apos 3 h
-- sem) vira uma linha em tempo.trovoada_aviso, ENVIADA OU NAO, com as
-- caracteristicas do momento (distancia, tamanho da tempestade, aproximacao).
-- 2 h depois o proprio banco confere: chegou descarga a ate 10 km? Isso vale
-- para os avisos suprimidos tambem — senao uma faixa suprimida nunca mais teria
-- dado para provar que melhorou.
--
-- A chance mostrada na mensagem e a taxa da FAIXA (distancia x celulas):
--   (acertos + peso * prior) / (verificados + peso)
-- O prior vem do backtest; com poucos casos reais ele domina, com muitos o
-- observado domina. Faixa cuja chance cai abaixo de limiar_chance deixa de ser
-- avisada (continua sendo registrada e conferida).
--
-- Os quadros do STSC sobre o RJ ficam guardados 180 dias (trovoada_quadro), para
-- testar regras futuras com dados reais, nao so com o historico de jan-jul.

-- ------------------------------------------------------------------ tabelas
create table if not exists tempo.trovoada_quadro (
  quadro timestamptz primary key,
  la real[] not null,
  lo real[] not null
);

create table if not exists tempo.trovoada_prior (
  faixa text primary key,        -- '10-20|1-4', distancia | celulas a ate 50 km
  acerto real not null,
  n int not null,
  fonte text not null
);
insert into tempo.trovoada_prior (faixa, acerto, n, fonte) values
  ('10-20|1-4',  0.483, 327, 'backtest D17 jan-jul/2026'),
  ('10-20|5-14', 0.555, 456, 'backtest D17 jan-jul/2026'),
  ('10-20|15+',  0.739, 153, 'backtest D17 jan-jul/2026'),
  ('20-30|1-4',  0.413, 789, 'backtest D17 jan-jul/2026'),
  ('20-30|5-14', 0.508, 728, 'backtest D17 jan-jul/2026'),
  ('20-30|15+',  0.750,  36, 'backtest D17 jan-jul/2026')
on conflict (faixa) do update set acerto = excluded.acerto, n = excluded.n, fonte = excluded.fonte;

create table if not exists tempo.trovoada_param (chave text primary key, valor real not null, nota text);
insert into tempo.trovoada_param values
  ('limiar_chance', 0.40, 'faixa com chance abaixo disto nao e avisada (segue registrada e conferida)'),
  ('peso_prior',    30,   'quantos casos reais o prior do backtest vale'),
  ('janela_dias',   90,   'so os avisos verificados nos ultimos N dias entram na conta')
on conflict (chave) do nothing;

create table if not exists tempo.trovoada_aviso (
  id bigserial primary key,
  municipio_ibge int not null,
  regiao text,
  emitido_em timestamptz not null,
  dist_km real,
  celulas_50km smallint,
  aprox_km real,                 -- quanto a celula mais proxima chegou mais perto em ~30 min (pode ser negativo)
  faixa text,
  chance real,                   -- a chance que o sistema atribuiu no momento
  enviado boolean not null default false,
  verificado_em timestamptz,
  chegou boolean,
  chegou_em timestamptz,
  menor_dist_km real             -- o mais perto que uma celula chegou nas 2 h seguintes
);
create index if not exists trovoada_aviso_mun on tempo.trovoada_aviso (municipio_ibge, emitido_em desc);
create index if not exists trovoada_aviso_pend on tempo.trovoada_aviso (emitido_em) where verificado_em is null;

alter table tempo.trovoada_estado add column if not exists aprox_km real;
alter table tempo.trovoada_estado add column if not exists faixa text;
alter table tempo.trovoada_estado add column if not exists chance real;
alter table tempo.tg_regiao_trovoada add column if not exists municipios_no text[] not null default '{}';

-- ------------------------------------------------------------------ a chance aprendida
create or replace function tempo.trovoada_faixa(p_dist real, p_cel int)
returns text language sql immutable as $$
  select case when p_dist <= 20 then '10-20' else '20-30' end || '|' ||
         case when coalesce(p_cel, 0) < 5 then '1-4' when p_cel < 15 then '5-14' else '15+' end
$$;

create or replace view tempo.trovoada_desempenho as
with par as (
  select max(valor) filter (where chave = 'peso_prior') as peso,
         max(valor) filter (where chave = 'janela_dias') as dias
    from tempo.trovoada_param
), obs as (
  select a.faixa, count(*) as n, count(*) filter (where a.chegou) as acertos
    from tempo.trovoada_aviso a, par
   where a.verificado_em is not null and a.emitido_em >= now() - make_interval(days => par.dias::int)
   group by 1
)
select p.faixa, p.acerto as prior, coalesce(o.n, 0) as verificados, coalesce(o.acertos, 0) as acertos,
       ((coalesce(o.acertos, 0) + par.peso * p.acerto) / (coalesce(o.n, 0) + par.peso))::real as chance
  from tempo.trovoada_prior p cross join par left join obs o using (faixa);

-- ------------------------------------------------------------------ conferencia
-- Chamada pela ingestao (a cada 6 min). Confere avisos com mais de 2 h.
create or replace function tempo.trovoada_verificar()
returns integer language plpgsql security definer set search_path = tempo, pg_catalog as $$
declare n integer;
begin
  with pend as (
    select a.id, a.municipio_ibge, a.emitido_em, p.lat, p.lon
      from tempo.trovoada_aviso a
      join tempo.ponto p on p.municipio_ibge = a.municipio_ibge and p.principal
     where a.verificado_em is null and a.emitido_em < now() - interval '2 hours'
     limit 500
  ), res as (
    select pend.id,
           (select min(e.em) from tempo.trovoada_evento e
             where e.municipio_ibge = pend.municipio_ibge and e.para = 'no_municipio'
               and e.em > pend.emitido_em and e.em <= pend.emitido_em + interval '2 hours') as chegou_em,
           (select min(sqrt(power((c.lo - pend.lon) * 111.32 * cos(radians(-22.0)), 2) +
                            power((c.la - pend.lat) * 110.57, 2)))
              from tempo.trovoada_quadro q
              cross join lateral unnest(q.la, q.lo) as c(la, lo)
             where q.quadro > pend.emitido_em and q.quadro <= pend.emitido_em + interval '2 hours') as menor
      from pend
  )
  update tempo.trovoada_aviso a
     set verificado_em = now(),
         chegou = res.chegou_em is not null or coalesce(res.menor <= 10, false),
         chegou_em = res.chegou_em,
         menor_dist_km = res.menor::real
    from res where a.id = res.id;
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------------ ingestao
drop function if exists public.tempo_ingerir_trovoada(jsonb);
create or replace function public.tempo_ingerir_trovoada(p_rows jsonb, p_quadros jsonb default '[]')
returns integer language plpgsql security definer set search_path = tempo, public as $$
declare n integer;
begin
  -- quadros do STSC (so celulas sobre o RJ, o coletor ja recorta)
  insert into tempo.trovoada_quadro (quadro, la, lo)
  select (q->>'t')::timestamptz,
         array(select x::real from jsonb_array_elements_text(q->'la') x),
         array(select x::real from jsonb_array_elements_text(q->'lo') x)
    from jsonb_array_elements(p_quadros) q
  on conflict (quadro) do update set la = excluded.la, lo = excluded.lo;

  create temporary table _novo on commit drop as
  select (r->>'municipio_ibge')::int   as municipio_ibge,
         (r->>'quadro')::timestamptz   as quadro,
         r->>'situacao'                as situacao,
         (r->>'dist_km')::real         as dist_km,
         (r->>'velocidade_kmh')::real  as velocidade_kmh,
         (r->>'chegada_em')::timestamptz as chegada_em,
         coalesce((r->>'celulas_50km')::smallint, 0) as celulas_50km,
         (r->>'ultima_perto')::timestamptz as ultima_perto,
         r->>'vem_de'                  as vem_de,
         (r->>'aprox_km')::real        as aprox_km,
         (r->>'dist_alerta_km')::real  as dist_alerta_km,
         null::text as faixa, null::real as chance
    from jsonb_array_elements(p_rows) r;

  update _novo n
     set faixa = tempo.trovoada_faixa(coalesce(n.dist_alerta_km, n.dist_km), n.celulas_50km)
   where n.situacao = 'a_caminho';
  update _novo n set chance = d.chance
    from tempo.trovoada_desempenho d where d.faixa = n.faixa;

  -- inicio de episodio: entrou em a_caminho e nao houve aviso deste municipio nas ultimas 3 h
  insert into tempo.trovoada_aviso (municipio_ibge, regiao, emitido_em, dist_km, celulas_50km, aprox_km, faixa, chance)
  select n.municipio_ibge, p.regiao_painel, n.quadro, coalesce(n.dist_alerta_km, n.dist_km), n.celulas_50km,
         n.aprox_km, n.faixa, n.chance
    from _novo n
    join tempo.ponto p on p.municipio_ibge = n.municipio_ibge and p.principal
    left join tempo.trovoada_estado e on e.municipio_ibge = n.municipio_ibge
   where n.situacao = 'a_caminho'
     and e.situacao is distinct from 'a_caminho' and e.situacao is distinct from 'no_municipio'
     and not exists (select 1 from tempo.trovoada_aviso a
                      where a.municipio_ibge = n.municipio_ibge and a.emitido_em > n.quadro - interval '3 hours');

  insert into tempo.trovoada_evento (municipio_ibge, em, de, para, dist_km, velocidade_kmh, chegada_em)
  select n.municipio_ibge, n.quadro, e.situacao, n.situacao, n.dist_km, n.velocidade_kmh, n.chegada_em
    from _novo n left join tempo.trovoada_estado e using (municipio_ibge)
   where e.situacao is distinct from n.situacao
     and not (e.situacao is null and n.situacao = 'nenhuma');

  insert into tempo.trovoada_estado as t
         (municipio_ibge, quadro, situacao, dist_km, velocidade_kmh, chegada_em,
          celulas_50km, ultima_perto, desde, atualizado_em, vem_de, aprox_km, faixa, chance)
  select municipio_ibge, quadro, situacao, dist_km, velocidade_kmh, chegada_em,
         celulas_50km, ultima_perto, quadro, now(), vem_de, aprox_km, faixa, chance
    from _novo
  on conflict (municipio_ibge) do update set
         quadro = excluded.quadro,
         desde = case when t.situacao = excluded.situacao then t.desde else excluded.quadro end,
         situacao = excluded.situacao,
         dist_km = excluded.dist_km,
         velocidade_kmh = excluded.velocidade_kmh,
         chegada_em = excluded.chegada_em,
         celulas_50km = excluded.celulas_50km,
         ultima_perto = excluded.ultima_perto,
         vem_de = excluded.vem_de,
         aprox_km = excluded.aprox_km,
         faixa = excluded.faixa,
         chance = excluded.chance,
         atualizado_em = now();
  get diagnostics n = row_count;

  perform tempo.trovoada_verificar();
  delete from tempo.trovoada_evento where em < now() - interval '180 days';
  delete from tempo.trovoada_quadro where quadro < now() - interval '180 days';
  return n;
end $$;
revoke all on function public.tempo_ingerir_trovoada(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.tempo_ingerir_trovoada(jsonb, jsonb) to service_role;

-- ------------------------------------------------------------------ plano do bot
-- Mudancas: (1) municipio em a_caminho so entra na mensagem se a chance da faixa
-- >= limiar; (2) volume: municipio NOVO "proximo" so reabre mensagem 2 h depois
-- da ultima; municipio NOVO "sobre a cidade" sai em ate 20 min; (3) cada
-- municipio leva a sua chance e o plano leva o desempenho medido.
create or replace function public.tempo_tg_plano_trovoada()
returns jsonb language plpgsql security definer set search_path = tempo, public as $$
declare
  reg record; st tempo.tg_regiao_trovoada; plano jsonb := '[]'; v_nivel text;
  nomes text[]; nomes_no text[]; novos text[]; novos_no text[]; manda text; v_lim real; desemp jsonb;
begin
  if (select max(quadro) from tempo.trovoada_estado) < now() - interval '30 minutes' then
    return plano;
  end if;
  select valor into v_lim from tempo.trovoada_param where chave = 'limiar_chance';
  select jsonb_build_object('verificados', coalesce(sum(verificados), 0), 'acertos', coalesce(sum(acertos), 0))
    into desemp from tempo.trovoada_desempenho;

  for reg in
    with t as (
      select t.*, p.regiao_painel, p.municipio,
             (t.situacao = 'no_municipio' or (t.situacao = 'a_caminho' and coalesce(t.chance, 0) >= v_lim)) as conta
        from tempo.trovoada_estado t join tempo.ponto p on p.municipio_ibge = t.municipio_ibge and p.principal
    )
    select regiao_painel as regiao,
           bool_or(situacao = 'no_municipio') as tem_no,
           bool_or(conta and situacao = 'a_caminho') as tem_cam,
           bool_or(situacao <> 'nenhuma') as ativa,
           max(quadro) as quadro,
           jsonb_agg(jsonb_build_object('nome', municipio, 'situacao', situacao, 'dist_km', dist_km,
                     'vem_de', vem_de, 'chance', chance, 'celulas_50km', celulas_50km)
                     order by situacao desc, dist_km) filter (where conta) as muns,
           array_agg(municipio order by municipio) filter (where conta) as nomes,
           array_agg(municipio order by municipio) filter (where situacao = 'no_municipio') as nomes_no
      from t group by 1
  loop
    select * into st from tempo.tg_regiao_trovoada where regiao = reg.regiao;
    if not found then
      insert into tempo.tg_regiao_trovoada (regiao) values (reg.regiao) returning * into st;
    end if;
    v_nivel := case when reg.tem_no then 'no_municipio' when reg.tem_cam then 'a_caminho' end;
    nomes := coalesce(reg.nomes, '{}');
    nomes_no := coalesce(reg.nomes_no, '{}');
    manda := null;
    if v_nivel is not null then
      novos := array(select unnest(nomes) except select unnest(st.municipios));
      novos_no := array(select unnest(nomes_no) except select unnest(st.municipios_no));
      if not st.aberto or st.ultimo_envio < now() - interval '3 hours' then
        manda := v_nivel;
      elsif cardinality(novos_no) > 0 and st.ultimo_envio < now() - interval '20 minutes' then
        manda := 'no_municipio';
      elsif cardinality(novos) > 0 and st.ultimo_envio < now() - interval '2 hours' then
        manda := v_nivel;
      end if;
      if manda is not null then
        update tempo.tg_regiao_trovoada
           set aberto = true,
               nivel = case when st.aberto and st.nivel = 'no_municipio' then 'no_municipio' else v_nivel end,
               municipios = array(select distinct unnest(st.municipios || nomes)),
               municipios_no = array(select distinct unnest(st.municipios_no || nomes_no)),
               ultimo_envio = now()
         where regiao = reg.regiao;
        -- o aviso aberto de cada municipio citado passa a constar como enviado
        update tempo.trovoada_aviso a set enviado = true
          from tempo.ponto p
         where p.principal and p.municipio = any(nomes) and p.regiao_painel = reg.regiao
           and a.municipio_ibge = p.municipio_ibge and a.verificado_em is null and not a.enviado;
        plano := plano || jsonb_build_object('regiao', reg.regiao, 'tipo', manda, 'silencioso', false,
                                             'municipios', reg.muns, 'quadro', reg.quadro,
                                             'novos', to_jsonb(novos), 'desempenho', desemp);
      end if;
    elsif st.aberto and not reg.ativa then
      update tempo.tg_regiao_trovoada
         set aberto = false, nivel = null, municipios = '{}', municipios_no = '{}', ultimo_envio = now()
       where regiao = reg.regiao;
      plano := plano || jsonb_build_object('regiao', reg.regiao, 'tipo', 'afastou', 'silencioso', true,
                                           'municipios', '[]'::jsonb, 'quadro', reg.quadro);
    end if;
  end loop;
  return plano;
end $$;
revoke all on function public.tempo_tg_plano_trovoada() from public, anon, authenticated;
grant execute on function public.tempo_tg_plano_trovoada() to service_role;

-- para consulta (admin/painel futuro): como o aviso esta indo
create or replace view public.tempo_trovoada_desempenho as
  select faixa, prior, verificados, acertos, chance from tempo.trovoada_desempenho;
revoke all on public.tempo_trovoada_desempenho from anon, authenticated;
