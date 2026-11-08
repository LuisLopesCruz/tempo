-- ============================================================================
-- 097 — Bot: /boletim de UM municipio (pedido do usuario, 08/11): "foto do que
-- esta no site" para o municipio escolhido. Mesmas contas do painel (hero) e
-- do boletim de regiao, mais trovoada agora e os dois riscos da Defesa Civil.
-- ============================================================================
create or replace function public.tempo_tg_municipios()
returns jsonb language sql stable security definer set search_path = tempo, public as $$
  select coalesce(jsonb_agg(jsonb_build_object('ibge', municipio_ibge, 'nome', municipio, 'regiao', regiao_painel)
                            order by municipio), '[]')
    from tempo.ponto where principal and ativo;
$$;

create or replace function public.tempo_tg_municipio(p_ibge integer)
returns jsonb language sql stable security definer set search_path = tempo, public as $$
with hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d,
                     date_trunc('day',   now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' as ini_dia,
                     date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' as ini_mes,
                     extract(month from now() at time zone 'America/Sao_Paulo')::int as mes),
pt as materialized (select id, municipio_ibge, municipio, regiao_painel from tempo.ponto
                     where municipio_ibge = p_ibge and principal limit 1),
prev as materialized (
  select max(prob_chuva)       filter (where horizonte_h between 0 and 6)  as p6,
         max(prob_chuva_forte) filter (where horizonte_h between 0 and 24) as forte24,
         sum(precip_mediana)   filter (where horizonte_h between 0 and 24) as mm24,
         sum(precip_p25)       filter (where horizonte_h between 0 and 24) as p25_24,
         sum(precip_p75)       filter (where horizonte_h between 0 and 24) as p75_24,
         max(rajada_max)       filter (where horizonte_h between 0 and 24) as raj24,
         max(temp_mediana)     filter (where horizonte_h between 0 and 24) as tmax,
         min(temp_mediana)     filter (where horizonte_h between 0 and 24) as tmin
    from public.tempo_previsao where ponto_id = (select id from pt)
),
obs as materialized (
  select sum(observado) filter (where hora >= (select ini_dia from hoje)) as mm_hoje, sum(observado) as mm_mes
    from (select distinct on (hora) hora, observado from tempo.obs_horaria, hoje
           where ponto_id = (select id from pt) and hora >= hoje.ini_mes and observado is not null
           order by hora, case fonte when 'alerta-rio' then 0 else 1 end) o
)
select jsonb_build_object(
  'municipio', pt.municipio, 'regiao', pt.regiao_painel,
  'k6', round(coalesce(pr.p6, 0) * 8)::int,
  'chance6', (select c.freq_observada from public.tempo_calibracao c
               order by abs(c.prob_painel - round(coalesce(pr.p6, 0) * 8) / 8.0) limit 1),
  'k_forte', round(coalesce(pr.forte24, 0) * 8)::int,
  'mm24', pr.mm24, 'p25_24', pr.p25_24, 'p75_24', pr.p75_24, 'raj24', pr.raj24, 'tmax', pr.tmax, 'tmin', pr.tmin,
  'mm_hoje', ob.mm_hoje, 'mm_mes', ob.mm_mes,
  'normal_mes', (select mm_normal from tempo.clima_normal where municipio_ibge = p_ibge and mes = hoje.mes),
  'risco_hoje',   (select nivel_risco from public.tempo_risco_energia where municipio_ibge = p_ibge and dia = hoje.d),
  'risco_amanha', (select nivel_risco from public.tempo_risco_energia where municipio_ibge = p_ibge and dia = hoje.d + 1),
  'trovoada', (select to_jsonb(t) from public.tempo_trovoada t where t.municipio_ibge = p_ibge),
  'dc', coalesce((select jsonb_agg(jsonb_build_object('tipo', tipo, 'nivel', nivel)) from public.tempo_risco_defesa_civil
                   where municipio_ibge = p_ibge), '[]'),
  'inmet', coalesce((select jsonb_agg(jsonb_build_object('descricao', descricao, 'severidade', severidade, 'fim', fim) order by fim)
                       from public.tempo_alertas_municipio
                      where municipio_ibge = p_ibge and fonte = 'inmet'
                        and inicio <= now() and (fim is null or fim >= now())), '[]'))
  from pt cross join hoje cross join prev pr cross join obs ob;
$$;

revoke all on function public.tempo_tg_municipios() from public, anon, authenticated;
revoke all on function public.tempo_tg_municipio(integer) from public, anon, authenticated;
grant execute on function public.tempo_tg_municipios() to service_role;
grant execute on function public.tempo_tg_municipio(integer) to service_role;
