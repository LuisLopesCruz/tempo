-- ============================================================================
-- 092 — Boletim de 6 em 6 h do bot (06h, 12h, 18h e 00h de Brasilia; a de
-- 00h sem som). Especificacao de 07/11 no PROJETO.md.
--
-- OS NUMEROS SAO OS DO PAINEL, calculados do mesmo jeito (renderHero):
--   6 h   k = round(max prob_chuva * 8); chance = linha da tabela de calibracao
--         mais proxima de k/8 (freqMedida/chanceTabela)
--   24 h  chuva forte = max prob_chuva_forte; acumulado = soma da mediana;
--         rajada = max rajada_max; temperatura = max/min da mediana
--   hoje  previsao do dia e % da normal do mes (tempo_previsao_dia)
--   risco eletrico de hoje e amanha (tempo_risco_energia)
--   alertas INMET vigentes agora e Defesa Civil em alto/muito alto
-- A funcao devolve os municipios; quem escolhe o PIOR de cada regiao e o
-- formato e a Edge Function — regra de exibicao, nao de dado.
-- ============================================================================
create or replace function public.tempo_tg_boletim()
returns jsonb language sql stable security definer set search_path = tempo, public as $$
-- 'materialized' em tudo: sem isso o planejador fundia as views e a funcao
-- estourou o statement timeout (07/11, 1a versao). Assim: 3,3 s para os 92.
with hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
prev as materialized (
  select municipio_ibge,
         max(prob_chuva)       filter (where horizonte_h between 0 and 6)  as p6,
         max(prob_chuva_forte) filter (where horizonte_h between 0 and 24) as forte24,
         sum(precip_mediana)   filter (where horizonte_h between 0 and 24) as mm24,
         max(rajada_max)       filter (where horizonte_h between 0 and 24) as raj24,
         max(temp_mediana)     filter (where horizonte_h between 0 and 24) as tmax,
         min(temp_mediana)     filter (where horizonte_h between 0 and 24) as tmin
    from public.tempo_previsao group by 1
),
cal as materialized (select prob_painel, freq_observada from public.tempo_calibracao),
pd as materialized (select municipio_ibge, mm_dia, pct_do_mes from public.tempo_previsao_dia, hoje where dia = hoje.d),
re as materialized (select municipio_ibge, dia, nivel_risco from public.tempo_risco_energia, hoje where dia in (hoje.d, hoje.d + 1)),
m as materialized (
  select p.municipio_ibge, p.municipio, p.regiao_painel as regiao,
         round(coalesce(pr.p6, 0) * 8)::int as k6,
         (select c.freq_observada from cal c
           order by abs(c.prob_painel - round(coalesce(pr.p6, 0) * 8) / 8.0) limit 1) as chance6,
         pr.forte24, pr.mm24, pr.raj24, pr.tmax, pr.tmin,
         d.mm_dia, d.pct_do_mes,
         (select nivel_risco from re, hoje where re.municipio_ibge = p.municipio_ibge and re.dia = hoje.d)     as risco_hoje,
         (select nivel_risco from re, hoje where re.municipio_ibge = p.municipio_ibge and re.dia = hoje.d + 1) as risco_amanha
    from tempo.ponto p
    left join prev pr on pr.municipio_ibge = p.municipio_ibge
    left join pd d    on d.municipio_ibge  = p.municipio_ibge
   where p.principal and p.ativo
),
al as materialized (
  select p.regiao_painel as regiao, a.evento, a.descricao, a.severidade,
         max(a.fim) as fim, count(distinct a.municipio_ibge) as n
    from public.tempo_alertas_municipio a
    join tempo.ponto p on p.municipio_ibge = a.municipio_ibge and p.principal
   where a.fonte = 'inmet' and a.inicio <= now() and (a.fim is null or a.fim >= now())
   group by 1, 2, 3, 4
),
dc as materialized (
  select p.regiao_painel as regiao, r.tipo, r.nivel, array_agg(p.municipio order by p.municipio) as muns
    from public.tempo_risco_defesa_civil r
    join tempo.ponto p on p.municipio_ibge = r.municipio_ibge and p.principal
   where r.nivel in ('alto', 'muito_alto')
   group by 1, 2, 3
)
select coalesce(jsonb_agg(jsonb_build_object(
         'regiao', r.regiao,
         'muns',  (select jsonb_agg(to_jsonb(m) - 'regiao') from m where m.regiao = r.regiao),
         'inmet', coalesce((select jsonb_agg(to_jsonb(al) - 'regiao') from al where al.regiao = r.regiao), '[]'),
         'dc',    coalesce((select jsonb_agg(to_jsonb(dc) - 'regiao') from dc where dc.regiao = r.regiao), '[]'))), '[]')
  from (select distinct regiao_painel as regiao from tempo.ponto where principal and ativo) r;
$$;
revoke all on function public.tempo_tg_boletim() from public, anon, authenticated;
grant execute on function public.tempo_tg_boletim() to service_role;

-- 09, 15, 21 e 03 UTC = 06h, 12h, 18h e 00h de Brasilia. A previsao das 06,
-- 12, 18 e 00 UTC e coletada aos :30 — o boletim sai com a rodada fresca.
select cron.schedule('tempo_telegram_boletim', '0 3,9,15,21 * * *', $$select tempo.disparar_telegram('boletim');$$);
