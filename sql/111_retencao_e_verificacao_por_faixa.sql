-- 111 — Retencao revista e verificacao que cobre a faixa inteira
-- (pedido do usuario, 22/11: "Revise a retencao da verificacao e das
-- previsoes" e "corrige a verificacao tambem").
--
-- O banco e compartilhado com o PregadorAPP (Lumen) e estava em 459 de 500 MB.
--
-- 1. VERIFICACAO REPRESENTA CADA FAIXA PELO MEIO. Antes, nos 8 pontos-sentinela,
--    cada faixa de antecedencia guardava a emissao MAIS RECENTE que caia nela:
--    6-24h virava ~7-12h, 24-72h virava ~24-30h e 72-120h virava ~72-78h. Na
--    semana ate 22/11 nao houve um par sequer com 48-71h nem com 96-120h: o
--    peso "de 3 a 5 dias" de cada modelo media, na pratica, o dia 3. Agora a
--    faixa guarda a emissao mais perto do CENTRO (48h, 96h); 0-6h e 6-24h seguem
--    com a mais recente (como nos demais pontos). Para alcancar 96h com observacao que chega com
--    atraso, a leitura das previsoes passa de 4 para 6 dias.
--    Transicao: horas ja verificadas na faixa nao sao refeitas; por 45 dias os
--    grupos 24-72h e 72-120h misturam os dois criterios.
-- 2. PREVISAO: 10 -> 7 dias. Nada le previsao com mais de 6 dias (painel: 2;
--    verificacao: 6). Os 3 dias a menos eram guardados sem uso.
-- 3. VERIFICACAO segue com 45 dias (e a memoria dos pesos; ja foi de 90 para 45
--    em 15/10, sql/084). Os indices dela, inchados pelas remocoes diarias, sao
--    reconstruidos a parte (REINDEX), sem perder linha.

create or replace function tempo.verificar()
 returns integer language plpgsql security definer set search_path to 'tempo', 'public' as $function$
declare n integer;
begin
  with obs as (
    select distinct on (h.ponto_id, h.hora)
           h.ponto_id, h.hora, h.observado, h.fonte
      from tempo.obs_horaria h
     where h.hora > now() - interval '3 days'
       and h.observado is not null
     order by h.ponto_id, h.hora,
              case h.fonte when 'alerta-rio' then 0 else 1 end
  ),
  prev as (
    select p.ponto_id, p.linhagem_id, p.emitida_em,
           p.inicio_serie + ((i - 1) * p.passo_horas) * interval '1 hour' as valido_em,
           (p.dados->'precip_mm'->>(i-1))::real as previsto
      from tempo.previsao p,
           lateral generate_series(1, jsonb_array_length(p.dados->'precip_mm')) as i
     where p.coletada_em > now() - interval '6 days'     -- era 4: nao alcancava 96h
  ),
  cand as (
    select prev.ponto_id, prev.linhagem_id, prev.emitida_em, prev.valido_em,
           prev.previsto, obs.observado, obs.fonte, pt.verifica_longo,
           round(extract(epoch from (prev.valido_em - prev.emitida_em)) / 3600)::smallint as horizonte_h
      from prev
      join obs on obs.ponto_id = prev.ponto_id and obs.hora = prev.valido_em
      join tempo.ponto pt on pt.id = prev.ponto_id
     where prev.valido_em < date_trunc('hour', now())   -- ja aconteceu
       and prev.valido_em > prev.emitida_em             -- e era PREVISAO de verdade
       and prev.previsto is not null
  ),
  marcado as (
    select c.*, case when c.horizonte_h <=  6 then '0-6h'
                     when c.horizonte_h <= 24 then '6-24h'
                     when c.horizonte_h <= 72 then '24-72h'
                     else '72-120h' end as faixa,
           case when c.horizonte_h <=  6 then 0
                when c.horizonte_h <= 24 then 15
                when c.horizonte_h <= 72 then 48
                else 96 end as centro
      from cand c
  ),
  -- (a) regra de sempre, em TODOS os pontos: a emissao mais recente da hora,
  --     seja qual for a faixa em que ela caia. Mantida intacta para nao perder
  --     a hora que so tem emissao velha quando a coleta atrasa.
  curto as (
    select distinct on (ponto_id, linhagem_id, valido_em)
           ponto_id, linhagem_id, valido_em, previsto, observado, fonte, horizonte_h, faixa
      from marcado
     order by ponto_id, linhagem_id, valido_em, emitida_em desc
  ),
  -- (b) nos 8 pontos-sentinela, uma linha por FAIXA, com a emissao mais perto
  --     do CENTRO da faixa (22/11: antes era a mais recente, que deixava 48-71h
  --     e 96-120h sem nenhum par).
  longo as (
    select distinct on (ponto_id, linhagem_id, valido_em, faixa)
           ponto_id, linhagem_id, valido_em, previsto, observado, fonte, horizonte_h, faixa
      from marcado
     where verifica_longo
     order by ponto_id, linhagem_id, valido_em, faixa,
              -- so nas faixas que SO os sentinelas medem; em 0-6h e 6-24h segue a
              -- mais recente, igual a regra (a) — senao a mesma hora ganha dois
              -- pares na faixa 6-24h (visto na rodada de 22/11 15:25)
              case when faixa in ('24-72h', '72-120h') then abs(horizonte_h - centro) else 0 end,
              emitida_em desc
  ),
  pareado as (
    select * from curto
    union
    select * from longo
  )
  insert into tempo.verificacao (linhagem_id, ponto_id, variavel, horizonte_h, valido_em, previsto, observado, fonte_obs)
  select p.linhagem_id, p.ponto_id, 'precip_1h', p.horizonte_h, p.valido_em, p.previsto, p.observado, p.fonte
    from pareado p
   where not exists (
     select 1 from tempo.verificacao v
      where v.linhagem_id = p.linhagem_id and v.ponto_id = p.ponto_id
        and v.valido_em = p.valido_em and v.variavel = 'precip_1h'
        -- por faixa, nao por hora: senao o par de 0-6h ja gravado bloquearia
        -- para sempre o de 24-72h da mesma hora.
        and (case when v.horizonte_h <=  6 then '0-6h'
                  when v.horizonte_h <= 24 then '6-24h'
                  when v.horizonte_h <= 72 then '24-72h'
                  else '72-120h' end) = p.faixa
   );
  get diagnostics n = row_count;
  return n;
end;
$function$;

create or replace function tempo.aplicar_retencao()
 returns table(tabela text, removidos bigint) language plpgsql security definer set search_path to 'tempo', 'pg_catalog' as $function$
declare n bigint;
begin
  -- 7 dias (era 10): o painel le 2 dias e a verificacao 6 (sql/111).
  delete from tempo.previsao where coletada_em < now() - interval '7 days';
  get diagnostics n = row_count; tabela := 'previsao'; removidos := n; return next;

  delete from tempo.observacao where medido_em < now() - interval '120 days';
  get diagnostics n = row_count; tabela := 'observacao'; removidos := n; return next;

  delete from tempo.observacao_dia where dia < (now() at time zone 'America/Sao_Paulo')::date - 120;
  get diagnostics n = row_count; tabela := 'observacao_dia'; removidos := n; return next;

  delete from tempo.cemaden_req where pedido_em < now() - interval '7 days';
  get diagnostics n = row_count; tabela := 'cemaden_req'; removidos := n; return next;

  delete from tempo.fonte_req where pedido_em < now() - interval '30 days';
  get diagnostics n = row_count; tabela := 'fonte_req'; removidos := n; return next;

  -- previsao de impacto: 2 anos. NAO e descartavel como as outras — e o unico
  -- registro do que foi previsto, e so serve para verificar depois.
  delete from tempo.impacto_previsto where dia < (now() at time zone 'America/Sao_Paulo')::date - 730;
  get diagnostics n = row_count; tabela := 'impacto_previsto'; removidos := n; return next;

  -- 45 dias (era 90): ver cabecalho da migration 084.
  delete from tempo.verificacao where verificado_em < now() - interval '45 days';
  get diagnostics n = row_count; tabela := 'verificacao'; removidos := n; return next;

  delete from tempo.coleta_log where iniciada_em < now() - interval '30 days';
  get diagnostics n = row_count; tabela := 'coleta_log'; removidos := n; return next;

  delete from tempo.risco_municipio where visto_em < now() - interval '365 days';
  get diagnostics n = row_count; tabela := 'risco_municipio'; removidos := n; return next;
end;
$function$;

-- Manutencao feita uma vez em 22/11 (fora de migration, porque VACUUM nao roda
-- dentro de transacao):
--   delete from tempo.previsao where coletada_em < now() - interval '7 days';
--   vacuum full tempo.previsao;          -- o arquivo so encolhe com FULL
--   reindex table tempo.verificacao;     -- indices inchados pelas remocoes
--   vacuum full net._http_response;      -- respostas HTTP ja apagadas, arquivo cheio
