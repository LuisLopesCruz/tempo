-- 100 — impacto_pontuar() nunca tinha rodado de verdade (nao havia observado da
-- ANEEL ate 13/11). Tres defeitos escondidos, achados na 1a carga de setembro:
--  * DELETE e UPDATE sem WHERE: o Supabase barra (pg_safeupdate) quando a
--    chamada chega pela API -> "DELETE requires a WHERE clause" (HTTP 400).
--  * brier/skill_pct sao ao mesmo tempo coluna de saida da funcao e coluna da
--    tabela -> "column reference brier is ambiguous". #variable_conflict
--    use_column manda o PL/pgSQL ler sempre a coluna da tabela.
--  * climatologia: o Brier de prever sempre a taxa observada p e p(1-p).
create or replace function tempo.impacto_pontuar()
returns table(antecedencia integer, pares integer, brier real, skill_pct real)
language plpgsql security definer set search_path = tempo, pg_catalog as $$
#variable_conflict use_column
declare v_lim real;
begin
  select valor into v_lim from tempo.impacto_param where chave = 'limiar_dia_ruim';

  create temporary table _par on commit drop as
  select pv.ponto_id, pv.dia, i as ante, pv.prob[i] as p,
         (ob.chamados::real / nullif(pv.base_dia,0)) >= v_lim as ruim
    from tempo.impacto_previsto pv
    join tempo.impacto_observado ob on ob.ponto_id = pv.ponto_id and ob.dia = pv.dia
    cross join generate_series(1,6) as i
   where pv.prob[i] is not null and pv.base_dia > 0;

  delete from tempo.impacto_skill where true;
  insert into tempo.impacto_skill (antecedencia_dias, n_pares, n_dias, brier, brier_clim, skill_pct, taxa_obs)
  select (ante-1)::smallint, count(*)::int, count(distinct dia)::int,
         avg((p - case when ruim then 1 else 0 end)^2)::real,
         (avg(case when ruim then 1.0 else 0 end) * (1 - avg(case when ruim then 1.0 else 0 end)))::real,
         null, avg(case when ruim then 1 else 0 end)::real
    from _par group by 1;

  update tempo.impacto_skill s
     set skill_pct = case when s.brier_clim > 0 then (100*(1 - s.brier/s.brier_clim))::real end,
         atualizado_em = now()
   where true;

  delete from tempo.impacto_confiabilidade where true;
  insert into tempo.impacto_confiabilidade (antecedencia_dias, faixa, n_pares, prob_media, obs_freq)
  select (ante-1)::smallint,
         case when p < 0.08 then '<8%' when p < 0.12 then '8-12%'
              when p < 0.18 then '12-18%' when p < 0.28 then '18-28%'
              else '>=28%' end,
         count(*)::int, avg(p)::real, avg(case when ruim then 1 else 0 end)::real
    from _par group by 1, 2;

  return query
    select k.antecedencia_dias::int, k.n_pares, k.brier, k.skill_pct
      from tempo.impacto_skill k order by k.antecedencia_dias;
end $$;
