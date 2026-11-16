-- 107 — Trovoada: municipio NOVO "proximo" numa regiao que ja recebeu aviso
-- passa a sair depois de 40 min, nao mais 2 h (pedido do usuario, 16/11: "40min").
-- Motivo: em 16/11 o aviso da Regiao dos Lagos saiu as 14:37 sem Sao Pedro da
-- Aldeia (21%, abaixo do corte); as 14:48 a celula estava a 18 km com 44%, acima
-- do corte, e a cidade so seria avisada as 16:37. A espera vira parametro
-- (tempo.trovoada_param 'espera_novo_min'), para ajustar sem mexer em funcao.
insert into tempo.trovoada_param (chave, valor) values ('espera_novo_min', 40)
on conflict (chave) do update set valor = excluded.valor;

create or replace function public.tempo_tg_plano_trovoada()
returns jsonb language plpgsql security definer set search_path = tempo, public as $$
declare
  reg record; st tempo.tg_regiao_trovoada; plano jsonb := '[]'; v_nivel text;
  nomes text[]; nomes_no text[]; novos text[]; novos_no text[]; manda text; v_lim real; v_espera real; desemp jsonb;
begin
  if (select max(quadro) from tempo.trovoada_estado) < now() - interval '30 minutes' then
    return plano;
  end if;
  select valor into v_lim from tempo.trovoada_param where chave = 'limiar_chance';
  select coalesce(max(valor), 120) into v_espera from tempo.trovoada_param where chave = 'espera_novo_min';
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
      elsif cardinality(novos) > 0 and st.ultimo_envio < now() - make_interval(mins => v_espera::int) then
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
