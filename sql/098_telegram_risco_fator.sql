-- ============================================================================
-- 098 — Aviso de risco eletrico leva "quantas vezes o normal" (total esperado /
-- base do municipio), para o texto aprovado em 08/11: "o TEMPO-RJ espera cerca
-- de 3 vezes mais ocorrencias na rede eletrica do que num dia normal".
-- Mesma funcao do 096, so com o campo 'fator' a mais.
-- ============================================================================
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
               else 'atmosfera muito instável (energia para tempestade)' end as motivo,
             re.total_esperado / nullif(re.base_dia, 0) as fator
        from public.tempo_risco_energia re
        join tempo.ponto p on p.municipio_ibge = re.municipio_ibge and p.principal
       where re.nivel_risco = 'alto' and re.dia in (v_hoje, v_hoje + 1)
         and not exists (select 1 from tempo.tg_risco_enviado x where x.municipio_ibge = re.municipio_ibge and x.dia = re.dia)
  ), grava as (
    insert into tempo.tg_risco_enviado select municipio_ibge, dia from novos on conflict do nothing returning 1
  )
  select plano || coalesce(jsonb_agg(jsonb_build_object('tipo', 'risco', 'regiao', g.regiao,
           'quando', case when g.dia = v_hoje then 'hoje' else 'amanhã' end,
           'motivo', g.motivo, 'fator', round(g.fator::numeric, 1), 'municipios', to_jsonb(g.muns))), '[]'::jsonb)
    into plano
    from (select regiao, dia, motivo, array_agg(municipio order by municipio) as muns, max(fator) as fator
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
