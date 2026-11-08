-- ============================================================================
-- 096 — Bot: avisos imediatos 2 a 5 (aprovados em 07/11) + "vindo de X" da trovoada
--   2 INMET laranja/vermelho novo, regiao que entrou num alerta, laranja -> vermelho
--   3 Defesa Civil: risco geologico/hidrologico subiu para alto ou muito alto
--   4 Risco eletrico ALTO previsto para hoje ou amanha (1 por municipio por dia)
--   5 Chuva forte MEDIDA: >= 30 mm em 1 h ou >= 50 mm em 24 h
-- Cada tipo guarda o que ja foi dito, para nao repetir a cada 6 min.
--
-- CHUVA MEDIDA: dois filtros, medidos em 08/11 sobre 59 dias de dado:
--   * leitura > 120 mm/h e descartada — Laje do Muriae marcou 189, 122 e 102
--     isolados entre zeros (defeito do pluviometro, nao chuva);
--   * leitura logo depois de um buraco e descartada — o pluviometro devolve o
--     acumulado do buraco como se fosse uma hora so (Levy Gasparian, 55 mm).
--   Com os filtros: >= 30 mm/h deu 15 municipio-dias em 9 dias; >= 50 mm/24 h,
--   45 em 20 dias (exige >= 20 das 24 h com leitura).
-- ============================================================================

-- ------------------------------------------------- trovoada: de onde vem
alter table tempo.trovoada_estado add column if not exists vem_de text;
create or replace view public.tempo_trovoada as
select municipio_ibge,
       case when quadro < now() - interval '30 minutes' then 'sem_dado' else situacao end as situacao,
       dist_km, velocidade_kmh, chegada_em, celulas_50km, quadro, desde, vem_de
  from tempo.trovoada_estado;
grant select on public.tempo_trovoada to anon, authenticated;

create or replace function public.tempo_ingerir_trovoada(p_rows jsonb)
returns integer language plpgsql security definer set search_path = tempo, public as $$
declare n integer;
begin
  with novo as (
    select (r->>'municipio_ibge')::int   as municipio_ibge,
           (r->>'quadro')::timestamptz   as quadro,
           r->>'situacao'                as situacao,
           (r->>'dist_km')::real         as dist_km,
           (r->>'velocidade_kmh')::real  as velocidade_kmh,
           (r->>'chegada_em')::timestamptz as chegada_em,
           coalesce((r->>'celulas_50km')::smallint, 0) as celulas_50km,
           (r->>'ultima_perto')::timestamptz as ultima_perto,
           r->>'vem_de'                  as vem_de
      from jsonb_array_elements(p_rows) r
  ),
  mudou as (
    insert into tempo.trovoada_evento (municipio_ibge, em, de, para, dist_km, velocidade_kmh, chegada_em)
    select n.municipio_ibge, n.quadro, e.situacao, n.situacao, n.dist_km, n.velocidade_kmh, n.chegada_em
      from novo n left join tempo.trovoada_estado e using (municipio_ibge)
     where e.situacao is distinct from n.situacao
       and not (e.situacao is null and n.situacao = 'nenhuma')
    returning 1
  )
  insert into tempo.trovoada_estado as t
         (municipio_ibge, quadro, situacao, dist_km, velocidade_kmh, chegada_em,
          celulas_50km, ultima_perto, desde, atualizado_em, vem_de)
  select municipio_ibge, quadro, situacao, dist_km, velocidade_kmh, chegada_em,
         celulas_50km, ultima_perto, quadro, now(), vem_de
    from novo
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
         atualizado_em = now();
  get diagnostics n = row_count;
  delete from tempo.trovoada_evento where em < now() - interval '180 days';
  return n;
end $$;

-- o plano da trovoada passa a levar velocidade e rumo de cada municipio
create or replace function public.tempo_tg_plano_trovoada()
returns jsonb language plpgsql security definer set search_path = tempo, public as $$
declare
  reg record; st tempo.tg_regiao_trovoada; plano jsonb := '[]'; v_nivel text;
  nomes text[]; novos text[]; manda text;
begin
  if (select max(quadro) from tempo.trovoada_estado) < now() - interval '30 minutes' then
    return plano;
  end if;
  for reg in
    select p.regiao_painel as regiao,
           bool_or(t.situacao = 'no_municipio') as tem_no,
           bool_or(t.situacao = 'a_caminho')    as tem_cam,
           bool_or(t.situacao <> 'nenhuma')     as ativa,
           max(t.quadro) as quadro,
           jsonb_agg(jsonb_build_object('nome', p.municipio, 'situacao', t.situacao,
                     'dist_km', t.dist_km, 'chegada_em', t.chegada_em,
                     'velocidade_kmh', t.velocidade_kmh, 'vem_de', t.vem_de)
                     order by t.situacao desc, t.dist_km) filter (where t.situacao in ('a_caminho','no_municipio')) as muns,
           array_agg(p.municipio order by p.municipio) filter (where t.situacao in ('a_caminho','no_municipio')) as nomes
      from tempo.trovoada_estado t join tempo.ponto p on p.municipio_ibge = t.municipio_ibge and p.principal
     group by 1
  loop
    select * into st from tempo.tg_regiao_trovoada where regiao = reg.regiao;
    if not found then
      insert into tempo.tg_regiao_trovoada (regiao) values (reg.regiao) returning * into st;
    end if;
    v_nivel := case when reg.tem_no then 'no_municipio' when reg.tem_cam then 'a_caminho' end;
    nomes := coalesce(reg.nomes, '{}');
    manda := null;
    if v_nivel is not null then
      novos := array(select unnest(nomes) except select unnest(st.municipios));
      if not st.aberto or st.ultimo_envio < now() - interval '3 hours' then
        manda := v_nivel;
      elsif v_nivel = 'no_municipio' and st.nivel = 'a_caminho' then
        manda := v_nivel;
      elsif cardinality(novos) > 0 and st.ultimo_envio < now() - interval '30 minutes' then
        manda := v_nivel;
      end if;
      if manda is not null then
        update tempo.tg_regiao_trovoada
           set aberto = true,
               nivel = case when st.aberto and st.nivel = 'no_municipio' then 'no_municipio' else v_nivel end,
               municipios = array(select distinct unnest(st.municipios || nomes)),
               ultimo_envio = now()
         where regiao = reg.regiao;
        plano := plano || jsonb_build_object('regiao', reg.regiao, 'tipo', manda, 'silencioso', false,
                                             'municipios', reg.muns, 'quadro', reg.quadro,
                                             'novos', to_jsonb(novos));
      end if;
    elsif st.aberto and not reg.ativa then
      update tempo.tg_regiao_trovoada
         set aberto = false, nivel = null, municipios = '{}', ultimo_envio = now()
       where regiao = reg.regiao;
      plano := plano || jsonb_build_object('regiao', reg.regiao, 'tipo', 'afastou', 'silencioso', true,
                                           'municipios', '[]'::jsonb, 'quadro', reg.quadro);
    end if;
  end loop;
  return plano;
end $$;

-- ------------------------------------------------- memoria do que ja foi dito
create table if not exists tempo.tg_inmet_estado (     -- por regiao, evento e gravidade
  regiao text, evento text, severidade text,
  fim timestamptz, municipios text[] not null default '{}',
  primary key (regiao, evento, severidade));
create table if not exists tempo.tg_dc_estado (        -- nivel ja avisado por municipio e tipo
  municipio_ibge integer, tipo text, nivel text not null,
  primary key (municipio_ibge, tipo));
create table if not exists tempo.tg_risco_enviado (    -- 1 por municipio por dia
  municipio_ibge integer, dia date, primary key (municipio_ibge, dia));
create table if not exists tempo.tg_chuva_enviado (    -- 1 por municipio a cada 6 h
  municipio_ibge integer primary key, em timestamptz not null);

create or replace function public.tempo_tg_plano_alertas()
returns jsonb language plpgsql security definer set search_path = tempo, public as $$
declare
  plano jsonb := '[]';
  a record; r record; st tempo.tg_inmet_estado;
  v_muns text[]; v_novos text[]; v_tipo text;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  -- 2. INMET: laranja/vermelho que comeca em ate 24 h
  for a in
    select al.evento, al.descricao, al.severidade, al.inicio, al.fim,
           case jsonb_typeof(al.bruto->'riscos') when 'array' then al.bruto->'riscos'->>0
                else al.bruto->>'riscos' end as riscos, p.regiao_painel as regiao,
           array_agg(distinct p.municipio order by p.municipio) as muns
      from tempo.alerta_oficial al
      cross join lateral unnest(al.municipios) m(ibge)
      join tempo.ponto p on p.municipio_ibge = m.ibge::int and p.principal
     where al.fonte = 'inmet' and al.severidade in ('perigo', 'grande_perigo')
       and al.fim >= now() and al.inicio <= now() + interval '24 hours'
     group by 1, 2, 3, 4, 5, 6, 7
     order by al.inicio
  loop
    select * into st from tempo.tg_inmet_estado
     where regiao = a.regiao and evento = a.evento and severidade = a.severidade;
    v_novos := null;
    if not found or st.fim < now() then
      v_tipo := case when a.severidade = 'grande_perigo' and exists (
                       select 1 from tempo.tg_inmet_estado
                        where regiao = a.regiao and evento = a.evento and severidade = 'perigo' and fim >= now())
                     then 'elevou' else 'novo' end;
      v_novos := a.muns;
      insert into tempo.tg_inmet_estado values (a.regiao, a.evento, a.severidade, a.fim, a.muns)
      on conflict (regiao, evento, severidade) do update set fim = excluded.fim, municipios = excluded.municipios;
    else
      v_novos := array(select unnest(a.muns) except select unnest(st.municipios) order by 1);
      v_tipo := 'entrou';
      update tempo.tg_inmet_estado
         set fim = greatest(fim, a.fim), municipios = array(select distinct unnest(municipios || a.muns))
       where regiao = a.regiao and evento = a.evento and severidade = a.severidade;
    end if;
    if cardinality(v_novos) > 0 then
      plano := plano || jsonb_build_object('tipo', 'inmet', 'regiao', a.regiao, 'como', v_tipo,
        'descricao', a.descricao, 'severidade', a.severidade, 'inicio', a.inicio, 'fim', a.fim,
        'riscos', a.riscos, 'municipios', to_jsonb(v_novos));
    end if;
  end loop;

  -- 3. Defesa Civil: subiu para alto/muito alto (ou de alto para muito alto)
  delete from tempo.tg_dc_estado e
   where not exists (select 1 from public.tempo_risco_defesa_civil d
                      where d.municipio_ibge = e.municipio_ibge and d.tipo = e.tipo
                        and d.nivel in ('alto', 'muito_alto'));
  -- (um comando so: o WITH grava o estado e o SELECT devolve o que avisar)
  with sobe as (
    select d.municipio_ibge, d.tipo, d.nivel, p.municipio, p.regiao_painel as regiao
      from public.tempo_risco_defesa_civil d
      join tempo.ponto p on p.municipio_ibge = d.municipio_ibge and p.principal
      left join tempo.tg_dc_estado e on e.municipio_ibge = d.municipio_ibge and e.tipo = d.tipo
     where d.nivel in ('alto', 'muito_alto')
       and (e.nivel is null or (e.nivel = 'alto' and d.nivel = 'muito_alto'))
  ), grava as (
    insert into tempo.tg_dc_estado (municipio_ibge, tipo, nivel)
    select municipio_ibge, tipo, nivel from sobe
    on conflict (municipio_ibge, tipo) do update set nivel = excluded.nivel
    returning 1
  )
  select plano || coalesce(jsonb_agg(jsonb_build_object('tipo', 'dc', 'regiao', g.regiao, 'itens', g.itens,
           'moderados', coalesce((select jsonb_agg(jsonb_build_object('tipo', d.tipo, 'municipio', p.municipio))
                                    from public.tempo_risco_defesa_civil d
                                    join tempo.ponto p on p.municipio_ibge = d.municipio_ibge and p.principal
                                   where p.regiao_painel = g.regiao and d.nivel = 'moderado'), '[]'::jsonb))), '[]'::jsonb)
    into plano
    from (select s.regiao,
                 jsonb_agg(jsonb_build_object('tipo', s.tipo, 'nivel', s.nivel, 'municipio', s.municipio)) as itens
            from sobe s group by s.regiao) g
   where (select count(*) from grava) >= 0;

  -- 4. Risco eletrico ALTO hoje/amanha, 1 por municipio por dia
  with novos as (
      select re.municipio_ibge, re.dia, p.municipio, p.regiao_painel as regiao,
             case greatest(coalesce(re.acrescimo_vento, 0), coalesce(re.acrescimo_raio, 0), coalesce(re.acrescimo_conveccao, 0))
               when coalesce(re.acrescimo_vento, 0) then 'rajada prevista de ' || replace(re.faixa_vento, '-', '–') || ' km/h'
               when coalesce(re.acrescimo_raio, 0)  then 'chuva forte prevista (' || re.faixa_raio || ' mm/h)'
               else 'atmosfera muito instável (energia para tempestade)' end as motivo
        from public.tempo_risco_energia re
        join tempo.ponto p on p.municipio_ibge = re.municipio_ibge and p.principal
       where re.nivel_risco = 'alto' and re.dia in (v_hoje, v_hoje + 1)
         and not exists (select 1 from tempo.tg_risco_enviado x where x.municipio_ibge = re.municipio_ibge and x.dia = re.dia)
  ), grava as (
    insert into tempo.tg_risco_enviado select municipio_ibge, dia from novos on conflict do nothing returning 1
  )
  select plano || coalesce(jsonb_agg(jsonb_build_object('tipo', 'risco', 'regiao', g.regiao,
           'quando', case when g.dia = v_hoje then 'hoje' else 'amanhã' end,
           'motivo', g.motivo, 'municipios', to_jsonb(g.muns))), '[]'::jsonb)
    into plano
    from (select regiao, dia, motivo, array_agg(municipio order by municipio) as muns
            from novos group by 1, 2, 3) g
   where (select count(*) from grava) >= 0;
  delete from tempo.tg_risco_enviado where dia < v_hoje - 2;

  -- 5. Chuva forte MEDIDA (com os dois filtros do cabecalho)
  with o as (
      select distinct on (ponto_id, hora) ponto_id, hora, observado
        from tempo.obs_horaria
       where hora > now() - interval '26 hours' and observado is not null
       order by ponto_id, hora, case fonte when 'alerta-rio' then 0 else 1 end
    ), f as (
      select o.*, lag(hora) over (partition by ponto_id order by hora) as h_ant from o
    ), v as (
      select ponto_id, hora,
             case when observado <= 120 and h_ant = hora - interval '1 hour' then observado end as mm from f
    ), w as (
      select ponto_id, hora, mm,
             sum(mm)   over (partition by ponto_id order by hora range between interval '23 hours' preceding and current row) as s24,
             count(mm) over (partition by ponto_id order by hora range between interval '23 hours' preceding and current row) as n24,
             row_number() over (partition by ponto_id order by hora desc) as rn
        from v
    ), ult as (
      select w.*, p.municipio_ibge, p.municipio, p.regiao_painel as regiao
        from w join tempo.ponto p on p.id = w.ponto_id
       where w.rn = 1 and w.hora > now() - interval '3 hours'
         and (w.mm >= 30 or (w.s24 >= 50 and w.n24 >= 20))
         and not exists (select 1 from tempo.tg_chuva_enviado c
                          where c.municipio_ibge = p.municipio_ibge and c.em > now() - interval '6 hours')
  ), grava as (
    insert into tempo.tg_chuva_enviado select municipio_ibge, now() from ult
    on conflict (municipio_ibge) do update set em = excluded.em returning 1
  )
  select plano || coalesce(jsonb_agg(jsonb_build_object('tipo', 'chuva', 'regiao', g.regiao, 'itens', g.itens)), '[]'::jsonb)
    into plano
    from (select regiao, jsonb_agg(jsonb_build_object('municipio', municipio, 'mm1h', round(mm::numeric, 1),
                                                      'mm24', round(s24::numeric, 1), 'hora', hora)) as itens
            from ult group by regiao) g
   where (select count(*) from grava) >= 0;

  return plano;
end $$;

revoke all on function public.tempo_tg_plano_alertas() from public, anon, authenticated;
grant execute on function public.tempo_tg_plano_alertas() to service_role;
revoke all on function public.tempo_ingerir_trovoada(jsonb) from public, anon, authenticated;
grant execute on function public.tempo_ingerir_trovoada(jsonb) to service_role;
revoke all on function public.tempo_tg_plano_trovoada() from public, anon, authenticated;
grant execute on function public.tempo_tg_plano_trovoada() to service_role;
