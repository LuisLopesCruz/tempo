-- ============================================================================
-- 089 — Bot do Telegram (@TempoRJ_bot), parte 2: cadastro + aviso de trovoada
-- ----------------------------------------------------------------------------
-- Especificacao no PROJETO.md (07/11/2026). Um bot, sem canal; cada pessoa
-- conversa em particular e escolhe regioes (as 11 do painel) ou "Todas".
-- Acesso FECHADO: quem da /start fica pendente ate o administrador aprovar.
-- O primeiro a falar com o bot vira administrador.
--
-- DADO PESSOAL: so o id da conversa, o nome que a pessoa usa no Telegram e as
-- regioes. Nada disto tem GRANT para anon — o painel nao enxerga.
-- ============================================================================

create table if not exists tempo.tg_inscrito (
  chat_id       bigint primary key,
  nome          text,
  usuario       text,
  status        text not null default 'pendente'
                check (status in ('pendente','ativo','parado','recusado')),
  admin         boolean not null default false,
  regioes       text[] not null default '{}',
  todas         boolean not null default false,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Estado do aviso de trovoada POR REGIAO (a mensagem e por regiao, nao por
-- pessoa): o que ja foi dito neste episodio, para nao repetir.
create table if not exists tempo.tg_regiao_trovoada (
  regiao        text primary key,
  aberto        boolean not null default false,
  nivel         text,                         -- a_caminho | no_municipio
  municipios    text[] not null default '{}',
  ultimo_envio  timestamptz
);

create table if not exists tempo.tg_envio (
  id         bigserial primary key,
  em         timestamptz not null default now(),
  chat_id    bigint,
  tipo       text not null,
  regiao     text,
  ok         boolean not null,
  erro       text
);
create index if not exists tg_envio_em on tempo.tg_envio (em);

-- ------------------------------------------------------------ cadastro
-- /start: cria ou reativa. Primeiro inscrito da historia vira admin e ativo.
create or replace function public.tempo_tg_start(p_chat bigint, p_nome text, p_usuario text)
returns jsonb language plpgsql security definer set search_path = tempo, public as $$
declare r tempo.tg_inscrito; novo boolean := false;
begin
  select * into r from tempo.tg_inscrito where chat_id = p_chat;
  if not found then
    novo := true;
    insert into tempo.tg_inscrito (chat_id, nome, usuario, status, admin)
    values (p_chat, p_nome, p_usuario,
            case when exists (select 1 from tempo.tg_inscrito where admin) then 'pendente' else 'ativo' end,
            not exists (select 1 from tempo.tg_inscrito where admin))
    returning * into r;
  else
    update tempo.tg_inscrito set nome = p_nome, usuario = p_usuario,
           status = case when status = 'parado' then 'ativo' else status end,
           atualizado_em = now()
     where chat_id = p_chat returning * into r;
  end if;
  return to_jsonb(r) || jsonb_build_object('novo', novo);
end $$;

create or replace function public.tempo_tg_get(p_chat bigint)
returns jsonb language sql stable security definer set search_path = tempo, public as $$
  select to_jsonb(i) from tempo.tg_inscrito i where chat_id = p_chat;
$$;

create or replace function public.tempo_tg_regioes(p_chat bigint, p_regioes text[], p_todas boolean)
returns jsonb language sql security definer set search_path = tempo, public as $$
  update tempo.tg_inscrito set regioes = p_regioes, todas = p_todas, atualizado_em = now()
   where chat_id = p_chat returning to_jsonb(tg_inscrito);
$$;

create or replace function public.tempo_tg_status(p_chat bigint, p_status text)
returns jsonb language sql security definer set search_path = tempo, public as $$
  update tempo.tg_inscrito set status = p_status, atualizado_em = now()
   where chat_id = p_chat returning to_jsonb(tg_inscrito);
$$;

create or replace function public.tempo_tg_admins()
returns setof bigint language sql stable security definer set search_path = tempo, public as $$
  select chat_id from tempo.tg_inscrito where admin and status = 'ativo';
$$;

create or replace function public.tempo_tg_destinatarios()
returns jsonb language sql stable security definer set search_path = tempo, public as $$
  select coalesce(jsonb_agg(jsonb_build_object('chat_id', chat_id, 'regioes', regioes, 'todas', todas)), '[]')
    from tempo.tg_inscrito where status = 'ativo' and (todas or cardinality(regioes) > 0);
$$;

create or replace function public.tempo_tg_log(p_chat bigint, p_tipo text, p_regiao text, p_ok boolean, p_erro text)
returns void language sql security definer set search_path = tempo, public as $$
  insert into tempo.tg_envio (chat_id, tipo, regiao, ok, erro) values (p_chat, p_tipo, p_regiao, p_ok, p_erro);
  delete from tempo.tg_envio where em < now() - interval '180 days';
$$;

-- ------------------------------------------- plano do aviso de trovoada
-- Decide, POR REGIAO, o que sai nesta rodada, e ja registra como dito.
-- Regras (especificacao de 07/11):
--   * comeca     -> sai (a_caminho ou no_municipio)
--   * piora      -> sai na hora (a_caminho -> no_municipio)
--   * municipio novo no mesmo nivel -> sai, mas no maximo a cada 30 min
--                   (linha larga acende municipio a cada 6 min: seria rajada de mensagem)
--   * 3 h sem mensagem e ainda ativa -> sai de novo (lembrete)
--   * todos os municipios da regiao sem trovoada a 50 km por 60 min -> "se afastou", sem som
-- Coletor parado (quadro > 30 min) -> nao planeja nada: silencio e melhor
-- do que avisar com dado velho.
create or replace function public.tempo_tg_plano_trovoada()
returns jsonb language plpgsql security definer set search_path = tempo, public as $$
declare
  reg record; st tempo.tg_regiao_trovoada; plano jsonb := '[]'; v_nivel text;
  nomes text[]; novos text[]; mun jsonb; manda text;
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
                     'dist_km', t.dist_km, 'chegada_em', t.chegada_em)
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

do $$
declare f text;
begin
  foreach f in array array['tempo_tg_start(bigint,text,text)','tempo_tg_get(bigint)',
    'tempo_tg_regioes(bigint,text[],boolean)','tempo_tg_status(bigint,text)','tempo_tg_admins()',
    'tempo_tg_destinatarios()','tempo_tg_log(bigint,text,text,boolean,text)','tempo_tg_plano_trovoada()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Disparo: configurar (uma vez) e avisos (a cada 6 min, 1 min depois da coleta)
create or replace function tempo.disparar_telegram(p_acao text default 'avisos')
returns bigint language plpgsql security definer
set search_path = tempo, net, public, pg_catalog as $$
declare v_url text; v_seg text; v_req bigint;
begin
  select valor into v_url from tempo.config where chave = 'funcoes_url';
  select valor into v_seg from tempo.config where chave = 'coletor_segredo';
  select net.http_post(
    url     := v_url || '/tempo-telegram?acao=' || p_acao,
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-tempo-secret', v_seg),
    timeout_milliseconds := 60000
  ) into v_req;
  return v_req;
end $$;
revoke all on function tempo.disparar_telegram(text) from public;

-- (ligado so depois do teste — ver 089 no historico)
-- select cron.schedule('tempo_telegram_avisos', '1-59/6 * * * *', $$select tempo.disparar_telegram('avisos');$$);
