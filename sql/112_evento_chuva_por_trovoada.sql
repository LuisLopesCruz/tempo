-- 112 — "Informar evento": o aviso de TROVOADA SOBRE A CIDADE vale como aviso de
-- CHUVA FORTE (pedido do usuario, 22/11: "Pode fazer as duas").
-- Caso que motivou: Petropolis, 22/11 16h e 18h30 — chuva forte relatada; o bot
-- tinha mandado "trovoada sobre a cidade" (15h43, 17h31, 18h25), que diz "raios,
-- chuva forte e rajadas", mas a regra de 109 so aceitava aviso de chuva medida
-- ou alerta laranja/vermelho do INMET, e os dois relatos foram para analise.
-- O aviso de "trovoada proxima" continua NAO valendo: ele diz "se chegar".
-- Os dois relatos de Petropolis sao reclassificados no fim.

create or replace function public.tempo_tg_evento(p_chat bigint, p_eventos text[], p_ibges integer[], p_regiao_toda boolean)
returns jsonb language plpgsql security definer set search_path = tempo, public, pg_catalog as $$
declare
  saida jsonb := '[]';
  v_ibge integer; v_ev text; p tempo.ponto; m jsonb; t tempo.trovoada_estado;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_trov timestamptz; v_inmet text; v_chuva boolean; v_dc boolean; v_risco text; v_raj real;
  v_lim real := (select valor from tempo.trovoada_param where chave = 'limiar_chance');
  v_ult timestamptz := (select max(quadro) from tempo.trovoada_quadro);
  v_avisou boolean; v_como text[]; v_nota text;
  hm text; v_trov_no timestamptz; hm_no text;
begin
  foreach v_ibge in array p_ibges loop
    select * into p from tempo.ponto where municipio_ibge = v_ibge and principal;
    continue when not found;
    m := public.tempo_tg_municipio(v_ibge);
    select * into t from tempo.trovoada_estado where municipio_ibge = v_ibge;
    -- avisos que CHEGARAM ao celular
    select r.ultimo_envio into v_trov from tempo.tg_regiao_trovoada r
     where r.regiao = p.regiao_painel and r.aberto and r.ultimo_envio > now() - interval '2 hours'
       and p.municipio = any(r.municipios);
    -- municipio citado como "trovoada sobre a cidade" num aviso enviado nas 2 h anteriores
    select r.ultimo_envio into v_trov_no from tempo.tg_regiao_trovoada r
     where r.regiao = p.regiao_painel and r.aberto and r.ultimo_envio > now() - interval '2 hours'
       and p.municipio = any(r.municipios_no);
    hm_no := to_char(v_trov_no at time zone 'America/Sao_Paulo', 'HH24"h"MI');
    select string_agg(distinct i.evento, ', ') into v_inmet from tempo.tg_inmet_estado i
     where i.fim >= now() and p.municipio = any(i.municipios);
    v_chuva := exists (select 1 from tempo.tg_chuva_enviado c where c.municipio_ibge = v_ibge and c.em > now() - interval '6 hours');
    v_dc    := exists (select 1 from tempo.tg_dc_estado d where d.municipio_ibge = v_ibge and d.tipo = 'hidrologico');
    v_risco := m->>'risco_hoje';
    v_raj   := (m->>'raj24')::real;
    hm := to_char(v_trov at time zone 'America/Sao_Paulo', 'HH24"h"MI');

    foreach v_ev in array p_eventos loop
      if exists (select 1 from tempo.evento_relato e where e.chat_id = p_chat and e.evento = v_ev
                    and e.municipio_ibge = v_ibge and e.relatado_em > now() - interval '20 minutes') then
        saida := saida || jsonb_build_object('evento', v_ev, 'municipio', p.municipio, 'repetido', true);
        continue;
      end if;
      v_como := '{}'; v_nota := null;
      if v_ev = 'trovoada' then
        if v_trov is not null then v_como := v_como || ('aviso de trovoada das ' || hm); end if;
        v_nota := case
          when v_ult is null or v_ult < now() - interval '30 minutes'
            then 'a REDEMET estava sem dados desde ' || to_char(v_ult at time zone 'America/Sao_Paulo', 'HH24"h"MI')
          when t.situacao = 'no_municipio' then 'o sistema via trovoada sobre a cidade'
          when t.situacao = 'a_caminho' and coalesce(t.chance, 0) < v_lim
            then format('o sistema via trovoada a ~%s km, com %s%% de chance de chegar: o corte de %s%% segurou o aviso',
                        round(t.dist_km), round(100 * t.chance), round(100 * v_lim))
          when t.situacao = 'a_caminho' then format('o sistema via trovoada a ~%s km (%s%% de chance)', round(t.dist_km), round(100 * t.chance))
          when t.situacao = 'perto' then format('o sistema via trovoada a ~%s km, fora da faixa de aviso (30 km)', round(t.dist_km))
          else 'a REDEMET não registrava trovoada a até 50 km' end;
      elsif v_ev = 'chuva' then
        if v_chuva then v_como := v_como || 'aviso de chuva forte medida'::text; end if;
        -- o aviso de "trovoada sobre a cidade" diz "raios, chuva forte e rajadas":
        -- vale como aviso de chuva forte. O de "trovoada proxima" nao ("se chegar").
        if v_trov_no is not null then v_como := v_como || ('aviso de trovoada sobre a cidade das ' || hm_no); end if;
        if v_inmet is not null then v_como := v_como || ('alerta do INMET (' || v_inmet || ')'); end if;
        v_nota := format('previsão: %s%% de chance de chuva em 6 h e ~%s mm em 24 h',
                         coalesce(round(100 * (m->>'chance6')::numeric)::text, '–'), coalesce(round((m->>'mm24')::numeric)::text, '–'));
      elsif v_ev = 'vento' then
        if v_inmet is not null then v_como := v_como || ('alerta do INMET (' || v_inmet || ')'); end if;
        if v_raj >= 60 then v_como := v_como || format('rajada de %s km/h no boletim', round(v_raj)); end if;
        v_nota := format('rajada máxima prevista: %s km/h', coalesce(round(v_raj)::text, '–'));
      elsif v_ev = 'granizo' then
        if v_inmet is not null then v_como := v_como || ('alerta do INMET (' || v_inmet || ')'); end if;
        v_nota := 'sem alerta do INMET em vigor para o município';
      elsif v_ev = 'alagamento' then
        if v_chuva then v_como := v_como || 'aviso de chuva forte medida'::text; end if;
        if v_inmet is not null then v_como := v_como || ('alerta do INMET (' || v_inmet || ')'); end if;
        if v_dc then v_como := v_como || 'Defesa Civil: risco de enchente'::text; end if;
        v_nota := format('previsão: ~%s mm em 24 h; Defesa Civil sem risco alto de enchente',
                         coalesce(round((m->>'mm24')::numeric)::text, '–'));
      elsif v_ev = 'falta_luz' then
        if v_risco in ('elevado', 'alto') then v_como := v_como || ('risco elétrico ' || v_risco || ' no boletim'); end if;
        if v_trov is not null then v_como := v_como || ('aviso de trovoada das ' || hm); end if;
        v_nota := 'risco elétrico previsto para hoje: ' || coalesce(v_risco, 'sem cálculo');
      end if;
      v_avisou := cardinality(v_como) > 0;
      insert into tempo.evento_relato (chat_id, evento, municipio_ibge, regiao_toda, avisou, classe, como, nota, base)
      values (p_chat, v_ev, v_ibge, p_regiao_toda, v_avisou,
              case when v_avisou then 'confirmacao' else 'analise' end,
              array_to_string(v_como, '; '), case when v_avisou then null else v_nota end,
              jsonb_build_object('trovoada', to_jsonb(t), 'chance6', m->'chance6', 'mm24', m->'mm24', 'raj24', m->'raj24',
                                 'risco_hoje', m->'risco_hoje', 'inmet', v_inmet, 'quadro', v_ult));
      saida := saida || jsonb_build_object('evento', v_ev, 'municipio', p.municipio, 'avisou', v_avisou,
                                           'como', array_to_string(v_como, '; '), 'nota', v_nota);
    end loop;
  end loop;
  return saida;
end $$;
revoke all on function public.tempo_tg_evento(bigint, text[], integer[], boolean) from public, anon, authenticated;
grant execute on function public.tempo_tg_evento(bigint, text[], integer[], boolean) to service_role;


update tempo.evento_relato
   set avisou = true, classe = 'confirmacao', nota = null,
       como = case id when 42 then 'aviso de trovoada sobre a cidade das 15h43'
                      when 43 then 'aviso de trovoada sobre a cidade das 18h25' end
 where id in (42, 43) and evento = 'chuva' and municipio_ibge = 3303906;
