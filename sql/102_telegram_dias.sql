-- 102 — Boletim em imagem: os proximos 3 dias do municipio (pedido do usuario,
-- 13/11: "enriquecer com mais detalhes, mas sem poluir"). Le a visao
-- materializada da previsao diaria (a mesma das barras do painel): instantaneo.
create or replace function public.tempo_tg_dias(p_ibge integer)
returns jsonb language sql stable security definer set search_path = tempo, public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'dia', v.dia, 'mm', round(v.mm_dia::numeric, 1), 'mm_min', round(v.mm_min::numeric, 1),
           'mm_max', round(v.mm_max::numeric, 1), 'familias', v.familias_com_chuva, 'n', v.n_familias)
           order by v.dia), '[]'::jsonb)
    from (select v.* from tempo.previsao_diaria_mat v
            join tempo.ponto p on p.id = v.ponto_id and p.principal and p.municipio_ibge = p_ibge
           where v.dia >= (now() at time zone 'America/Sao_Paulo')::date
           order by v.dia limit 3) v
$$;
revoke all on function public.tempo_tg_dias(integer) from public, anon, authenticated;
grant execute on function public.tempo_tg_dias(integer) to service_role;
