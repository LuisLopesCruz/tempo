-- 114 — "Informar evento": TROVOADA vira dois eventos, OUVI TROVAO e VI CLAROES
-- (pedido do usuario, 22/11: "Pode separar em vi claroes e ouvi trovao").
-- Motivo: em Sao Pedro da Aldeia, 22/11 19h49, o usuario via claroes sem ouvir
-- som, com a celula a 41 km (painel: "por perto, a ate 50 km"); em 16/11 ouviu
-- trovao com a celula a 26 km. Ver e ouvir dizem distancias diferentes — o
-- relato passa a registrar isso sem depender de comentario.
--  * trovao: confirmacao so com aviso de trovoada enviado (como antes);
--  * clarao: confirmacao tambem quando o sistema via trovoada a ate 50 km
--    (painel), porque para trovoada distante nao se manda aviso.
-- 'trovoada' fica aceito para os relatos antigos.

alter table tempo.evento_relato drop constraint if exists evento_relato_evento_check;
alter table tempo.evento_relato add constraint evento_relato_evento_check
  check (evento in ('trovao', 'clarao', 'trovoada', 'chuva', 'vento', 'granizo', 'alagamento', 'falta_luz'));

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
  hm text; v_trov_no timestamptz; hm_no text; v_nota_trov text;
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
    v_nota_trov := case
      when v_ult is null or v_ult < now() - interval '30 minutes'
        then 'a REDEMET estava sem dados desde ' || to_char(v_ult at time zone 'America/Sao_Paulo', 'HH24"h"MI')
      when t.situacao = 'no_municipio' then 'o sistema via trovoada sobre a cidade'
      when t.situacao = 'a_caminho' and coalesce(t.chance, 0) < v_lim
        then format('o sistema via trovoada a ~%s km, com %s%% de chance de chegar: o corte de %s%% segurou o aviso',
                    round(t.dist_km), round(100 * t.chance), round(100 * v_lim))
      when t.situacao = 'a_caminho' then format('o sistema via trovoada a ~%s km (%s%% de chance)', round(t.dist_km), round(100 * t.chance))
      when t.situacao = 'perto' then format('o sistema via trovoada a ~%s km, fora da faixa de aviso (30 km)', round(t.dist_km))
      else 'a REDEMET não registrava trovoada a até 50 km' end;

    foreach v_ev in array p_eventos loop
      if exists (select 1 from tempo.evento_relato e where e.chat_id = p_chat and e.evento = v_ev
                    and e.municipio_ibge = v_ibge and e.relatado_em > now() - interval '20 minutes') then
        saida := saida || jsonb_build_object('evento', v_ev, 'municipio', p.municipio, 'repetido', true);
        continue;
      end if;
      v_como := '{}'; v_nota := null;
      if v_ev in ('trovao', 'trovoada') then
        -- ouvi trovao: so o aviso de trovoada que chegou ao celular conta
        if v_trov is not null then v_como := v_como || ('aviso de trovoada das ' || hm); end if;
        v_nota := v_nota_trov;
      elsif v_ev = 'clarao' then
        -- vi claroes: clarao se ve de longe (trovoada a 40-50 km, sem som) e nao
        -- se manda aviso para trovoada distante. Conta como confirmacao se o
        -- sistema via trovoada a ate 50 km — o painel mostrava.
        if v_trov is not null then v_como := v_como || ('aviso de trovoada das ' || hm); end if;
        if v_trov is null and t.situacao in ('no_municipio', 'a_caminho', 'perto') and v_ult >= now() - interval '30 minutes' then
          v_como := v_como || format('painel: trovoada a ~%s km', round(t.dist_km));
        end if;
        v_nota := v_nota_trov;
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



-- relatos antigos: 16/11 14h34 ouviu (celula a 26 km); 22/11 19h49 viu claroes (41 km)
update tempo.evento_relato set evento = 'trovao' where id = 1 and evento = 'trovoada';
update tempo.evento_relato set evento = 'clarao' where id = 47 and evento = 'trovoada';
