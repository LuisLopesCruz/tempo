-- ============================================================================
-- 087 — Trovoada se aproximando (REDEMET/STSC), parte 1: coleta + painel
-- ----------------------------------------------------------------------------
-- Origem: tempestade de 07/11/2026, que nenhum modelo previu e que levou ~2 h
-- da Metropolitana aos Lagos. Regra testada no D15 (calibracao/13 e 14):
--   no_municipio  celula de trovoada a <= 10 km (em algum quadro dos ultimos 20 min)
--   a_caminho     celula a 10-50 km, >= 5 km mais perto do que ha ~30 min,
--                 a no maximo 90 km/h (em algum quadro dos ultimos 20 min)
--   perto         celula a <= 50 km em algum quadro dos ultimos 60 min
--   nenhuma       o resto
-- As janelas de 20/60 min sao a histerese: celula dura ~30 min no STSC e o
-- estado nao pode piscar a cada quadro de 6 min.
--
-- A CHAVE DA REDEMET NAO ESTA AQUI. Fica em tempo.config ('redemet_chave'),
-- gravada fora de migration (migration fica registrada no banco e no git), e
-- segue para a Edge Function no cabecalho que o pg_net monta — o mesmo caminho
-- do coletor_segredo.
-- ============================================================================

create table if not exists tempo.trovoada_estado (
  municipio_ibge  integer primary key,
  quadro          timestamptz not null,     -- quadro STSC mais recente usado
  situacao        text not null check (situacao in ('nenhuma','perto','a_caminho','no_municipio')),
  dist_km         real,                     -- celula mais proxima no ultimo quadro (null: nenhuma no RJ)
  velocidade_kmh  real,                     -- so em a_caminho
  chegada_em      timestamptz,              -- estimativa, so em a_caminho
  celulas_50km    smallint not null default 0,
  ultima_perto    timestamptz,              -- ultimo quadro com celula a <= 50 km
  desde           timestamptz not null,     -- quando entrou na situacao atual
  atualizado_em   timestamptz not null default now()
);

-- Cada MUDANCA de situacao. E o que o bot vai ler (aviso imediato) e o que
-- permite medir a regra ao vivo depois. Poucas linhas: so transicoes.
create table if not exists tempo.trovoada_evento (
  id              bigserial primary key,
  municipio_ibge  integer not null,
  em              timestamptz not null,
  de              text,
  para            text not null,
  dist_km         real,
  velocidade_kmh  real,
  chegada_em      timestamptz
);
create index if not exists trovoada_evento_em on tempo.trovoada_evento (em);

-- Pontos dos municipios para a Edge Function (o schema tempo nao e exposto).
create or replace function public.tempo_trovoada_alvos()
returns jsonb language sql stable security definer set search_path = tempo, public as $$
  select coalesce(jsonb_agg(jsonb_build_object('ibge', municipio_ibge, 'lat', lat, 'lon', lon)), '[]'::jsonb)
    from tempo.ponto where principal and ativo;
$$;

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
           (r->>'ultima_perto')::timestamptz as ultima_perto
      from jsonb_array_elements(p_rows) r
  ),
  mudou as (
    insert into tempo.trovoada_evento (municipio_ibge, em, de, para, dist_km, velocidade_kmh, chegada_em)
    select n.municipio_ibge, n.quadro, e.situacao, n.situacao, n.dist_km, n.velocidade_kmh, n.chegada_em
      from novo n left join tempo.trovoada_estado e using (municipio_ibge)
     where e.situacao is distinct from n.situacao
       and not (e.situacao is null and n.situacao = 'nenhuma')   -- primeira carga calma nao e evento
    returning 1
  )
  insert into tempo.trovoada_estado as t
         (municipio_ibge, quadro, situacao, dist_km, velocidade_kmh, chegada_em,
          celulas_50km, ultima_perto, desde, atualizado_em)
  select municipio_ibge, quadro, situacao, dist_km, velocidade_kmh, chegada_em,
         celulas_50km, ultima_perto, quadro, now()
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
         atualizado_em = now();
  get diagnostics n = row_count;
  delete from tempo.trovoada_evento where em < now() - interval '180 days';
  return n;
end $$;

revoke all on function public.tempo_trovoada_alvos() from public, anon, authenticated;
revoke all on function public.tempo_ingerir_trovoada(jsonb) from public, anon, authenticated;
grant execute on function public.tempo_trovoada_alvos() to service_role;
grant execute on function public.tempo_ingerir_trovoada(jsonb) to service_role;

-- View do painel. Estado com mais de 30 min vira 'sem_dado': coletor parado
-- nao pode continuar mostrando "sem trovoada" como se fosse noticia boa.
create or replace view public.tempo_trovoada as
select municipio_ibge,
       case when quadro < now() - interval '30 minutes' then 'sem_dado' else situacao end as situacao,
       dist_km, velocidade_kmh, chegada_em, celulas_50km, quadro, desde
  from tempo.trovoada_estado;
grant select on public.tempo_trovoada to anon, authenticated;

-- Disparo pelo pg_cron, mesmo molde dos outros coletores.
create or replace function tempo.disparar_trovoada()
returns bigint language plpgsql security definer
set search_path = tempo, net, public, pg_catalog as $$
declare v_url text; v_seg text; v_key text; v_req bigint;
begin
  select valor into v_url from tempo.config where chave = 'funcoes_url';
  select valor into v_seg from tempo.config where chave = 'coletor_segredo';
  select valor into v_key from tempo.config where chave = 'redemet_chave';
  if v_url is null or v_seg is null or v_key is null then
    raise exception 'tempo.config incompleto (funcoes_url, coletor_segredo, redemet_chave)';
  end if;
  select net.http_post(
    url     := v_url || '/tempo-coletar-trovoada',
    body    := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-tempo-secret', v_seg,
                                  'x-redemet-key', v_key),
    timeout_milliseconds := 60000
  ) into v_req;
  return v_req;
end $$;
revoke all on function tempo.disparar_trovoada() from public;

-- O STSC solta um quadro a cada 6-9 min.
select cron.schedule('tempo_coletar_trovoada', '*/6 * * * *', 'select tempo.disparar_trovoada();');
