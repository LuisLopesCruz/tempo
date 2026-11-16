-- 106 — Trovoada: falha da REDEMET deixa de ser silenciosa, e o "ouvi trovoada"
-- vira dado (pedido do usuario, 16/11: "As duas").
--
-- Motivo (16/11): a REDEMET ficou 1h43 sem publicar quadros (12:40 -> 14:23
-- BRT). O coletor respondeu "ok" a cada 6 min, o boletim emitido nesse
-- intervalo ficou sem trovoada e o usuario ouviu trovoada em Sao Pedro da
-- Aldeia sem aviso. O aprendizado da regra D17 so mede "a celula chegou a 10 km";
-- "deu para ouvir" nao entrava em lugar nenhum.

-- ------------------------------------------------------------------ 1. falha da REDEMET
-- Uma linha. falha_desde = ultimo quadro bom quando a falha foi notada.
create table if not exists tempo.redemet_falha (
  id          boolean primary key default true check (id),
  falha_desde timestamptz,
  avisado_em  timestamptz
);
insert into tempo.redemet_falha (id) values (true) on conflict do nothing;
alter table tempo.redemet_falha enable row level security;

-- Chamada a cada rodada de avisos do bot (6 em 6 min). Devolve o que fazer,
-- UMA vez por falha: 'falha' quando o quadro mais novo passa de 30 min (mesmo
-- corte do painel, que mostra "sem dado"), 'volta' quando chega quadro novo.
create or replace function public.tempo_tg_redemet_situacao()
returns jsonb language plpgsql security definer set search_path = tempo, pg_catalog as $$
declare
  ult timestamptz := (select max(quadro) from tempo.trovoada_quadro);
  f   tempo.redemet_falha;
begin
  select * into f from tempo.redemet_falha where id for update;
  if ult is null then return null; end if;
  if ult < now() - interval '30 minutes' then
    if f.falha_desde is null then
      update tempo.redemet_falha set falha_desde = ult, avisado_em = now() where id;
      return jsonb_build_object('acao', 'falha', 'desde', ult);
    end if;
    return null;
  end if;
  if f.falha_desde is not null then
    update tempo.redemet_falha set falha_desde = null, avisado_em = null where id;
    return jsonb_build_object('acao', 'volta', 'desde', f.falha_desde, 'voltou', ult);
  end if;
  return null;
end $$;
revoke all on function public.tempo_tg_redemet_situacao() from public, anon, authenticated;
grant execute on function public.tempo_tg_redemet_situacao() to service_role;

-- ------------------------------------------------------------------ 2. relato "ouvi trovoada"
-- Verdade de campo. Guarda o relato e, junto, o que o sistema via naquela hora:
-- e isso que permite medir a distancia a que a trovoada e ouvida e quantos
-- relatos caem em faixa que o corte de 40% silenciou.
create table if not exists tempo.trovoada_relato (
  id             bigserial primary key,
  chat_id        bigint not null,
  municipio_ibge integer not null,
  relatado_em    timestamptz not null default now(),
  quadro         timestamptz,          -- leitura da REDEMET mais nova naquela hora
  situacao       text,                 -- situacao do municipio naquela leitura
  dist_km        real,                 -- celula mais proxima no ultimo quadro
  menor_30min_km real,                 -- celula mais proxima nos quadros dos ultimos 30 min
  faixa          text,
  chance         real,
  vem_de         text,
  aviso_id       bigint references tempo.trovoada_aviso(id)   -- aviso do municipio nas 3 h anteriores
);
create index if not exists trovoada_relato_mun on tempo.trovoada_relato (municipio_ibge, relatado_em);
alter table tempo.trovoada_relato enable row level security;

create or replace function public.tempo_tg_relatar(p_chat bigint, p_ibge integer)
returns jsonb language plpgsql security definer set search_path = tempo, pg_catalog as $$
declare
  p  tempo.ponto;
  e  tempo.trovoada_estado;
  ult timestamptz := (select max(quadro) from tempo.trovoada_quadro);
  menor real;
  av tempo.trovoada_aviso;
  rid bigint;
begin
  select * into p from tempo.ponto where municipio_ibge = p_ibge and principal;
  if not found then return null; end if;
  -- o mesmo relato repetido nao conta duas vezes
  if exists (select 1 from tempo.trovoada_relato
              where chat_id = p_chat and municipio_ibge = p_ibge and relatado_em > now() - interval '20 minutes') then
    return jsonb_build_object('repetido', true, 'municipio', p.municipio);
  end if;
  select * into e from tempo.trovoada_estado where municipio_ibge = p_ibge;
  select min(sqrt(power((c.lo - p.lon) * 111.32 * cos(radians(-22.0)), 2) + power((c.la - p.lat) * 110.57, 2)))::real
    into menor
    from tempo.trovoada_quadro q cross join lateral unnest(q.la, q.lo) as c(la, lo)
   where q.quadro > ult - interval '30 minutes';
  select * into av from tempo.trovoada_aviso
   where municipio_ibge = p_ibge and emitido_em > now() - interval '3 hours'
   order by emitido_em desc limit 1;
  insert into tempo.trovoada_relato (chat_id, municipio_ibge, quadro, situacao, dist_km, menor_30min_km,
                                     faixa, chance, vem_de, aviso_id)
  values (p_chat, p_ibge, ult,
          case when ult < now() - interval '30 minutes' then 'sem_dado' else e.situacao end,
          e.dist_km, menor, e.faixa, e.chance, e.vem_de, av.id)
  returning id into rid;
  return jsonb_build_object('id', rid, 'municipio', p.municipio, 'regiao', p.regiao_painel,
    'quadro', ult, 'sem_dado', ult < now() - interval '30 minutes',
    'situacao', e.situacao, 'dist_km', e.dist_km, 'menor_30min_km', menor, 'vem_de', e.vem_de,
    'chance', e.chance, 'limiar', (select valor from tempo.trovoada_param where chave = 'limiar_chance'),
    'aviso_em', av.emitido_em, 'aviso_enviado', av.enviado);
end $$;
revoke all on function public.tempo_tg_relatar(bigint, integer) from public, anon, authenticated;
grant execute on function public.tempo_tg_relatar(bigint, integer) to service_role;

-- O que os relatos ensinam. Nao mexe no calculo da chance (que mede "chegou a
-- 10 km") enquanto houver poucos relatos: com 2 pessoas relatando, a amostra e
-- pequena e enviesada para onde elas estao. Serve para decidir, com numero, se
-- o corte de 40% deve cair para trovoada AUDIVEL.
create or replace view tempo.trovoada_relato_resumo as
select case when situacao = 'sem_dado'      then '0 sem leitura da REDEMET'
            when menor_30min_km is null     then '6 nada no RJ'
            when menor_30min_km <= 10       then '1 ate 10 km'
            when menor_30min_km <= 20       then '2 10-20 km'
            when menor_30min_km <= 30       then '3 20-30 km'
            when menor_30min_km <= 50       then '4 30-50 km'
            else                                 '5 mais de 50 km' end as distancia,
       count(*)                                          as relatos,
       count(*) filter (where aviso_id is not null)      as com_aviso_registrado,
       count(*) filter (where chance < (select valor from tempo.trovoada_param where chave = 'limiar_chance')) as abaixo_do_corte,
       round(avg(menor_30min_km)::numeric, 1)            as km_medio
  from tempo.trovoada_relato
 group by 1 order by 1;
