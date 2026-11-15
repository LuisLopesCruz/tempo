-- 103 — ANEEL sem robo automatico + aviso no rodape do painel (pedidos do usuario, 15/11)
--
-- "Pode excluir o robo do GitHub, porque se nao funciona, melhor apagar." O
-- site da ANEEL derruba toda conexao vinda do GitHub desde 11/11; a carga
-- passa a ser MANUAL (calibracao/8_sincronizar_aneel.py, rodado daqui).
--   * sai da saude a linha 6 "Robo da ANEEL" (sem robo, ela ficaria vermelha
--     para sempre e acenderia o aviso do topo do painel);
--   * tempo.aneel_arquivo guarda o que a ANEEL ja publicou (o script grava a
--     cada execucao, lendo o rodape do parquet) e ate onde o modelo foi
--     calibrado;
--   * public.tempo_aneel_situacao alimenta o aviso do rodape: "existem dados
--     disponiveis nao baixados e incorporados ao modelo".

create table if not exists tempo.aneel_arquivo (
  id boolean primary key default true check (id),     -- uma linha so
  arquivo_ate date not null,          -- ultimo dia do ultimo mes publicado pela ANEEL
  publicado_em date,                  -- data do arquivo no portal de dados abertos
  conferido_em timestamptz not null default now(),   -- quando alguem olhou o portal
  calibrado_ate date not null         -- ultimo dia de dado ANEEL usado na calibracao do impacto
);
insert into tempo.aneel_arquivo (arquivo_ate, publicado_em, conferido_em, calibrado_ate)
values ('2026-09-30', '2026-11-12', '2026-11-15 13:00-03', '2026-08-31')
on conflict (id) do update set arquivo_ate = excluded.arquivo_ate, publicado_em = excluded.publicado_em,
  conferido_em = excluded.conferido_em, calibrado_ate = excluded.calibrado_ate;

-- o script manual grava o que leu no rodape do parquet
create or replace function public.tempo_aneel_arquivo(p_segredo text, p_arquivo_ate date, p_publicado_em date)
returns void language plpgsql security definer set search_path = tempo, public as $$
declare v_seg text;
begin
  select valor into v_seg from tempo.config where chave = 'ingestao_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then raise exception 'nao autorizado'; end if;
  update tempo.aneel_arquivo
     set arquivo_ate = greatest(arquivo_ate, p_arquivo_ate),
         publicado_em = coalesce(p_publicado_em, publicado_em),
         conferido_em = now()
   where id;
end $$;
revoke all on function public.tempo_aneel_arquivo(text, date, date) from public, authenticated;
grant execute on function public.tempo_aneel_arquivo(text, date, date) to anon, service_role;

create or replace view public.tempo_aneel_situacao as
select a.arquivo_ate, a.publicado_em, a.conferido_em, a.calibrado_ate,
       e.observado_ate, e.previsto_de, e.previsto_ate, e.pares_verificados,
       -- publicado e ainda fora da conferencia das previsoes
       (a.arquivo_ate > coalesce(e.observado_ate, e.previsto_de - 1)) as falta_baixar,
       -- publicado e ainda fora da calibracao do modelo de impacto
       (a.arquivo_ate > a.calibrado_ate) as falta_calibrar
  from tempo.aneel_arquivo a cross join public.tempo_aneel_estado e;
grant select on public.tempo_aneel_situacao to anon, authenticated;

-- saude: sem a linha do robo
create or replace view public.tempo_saude as
 WITH log AS (
         SELECT coleta_log.fonte, coleta_log.iniciada_em, coleta_log.ok,
                COALESCE(coleta_log.erro, ''::text) AS erro
           FROM tempo.coleta_log
          WHERE coleta_log.iniciada_em > (now() - '7 days'::interval)
        ), f AS (
         SELECT 1 AS ordem, 'previsao'::text AS chave, 'Previsão dos modelos'::text AS rotulo,
                'a previsão está defasada'::text AS efeito, '07:00:00'::interval AS tolerancia,
                (SELECT max(previsao.coletada_em) FROM tempo.previsao) AS ultima_ok
        UNION ALL
         SELECT 2, 'alertario', 'Chuva medida (Alerta Rio)', 'a chuva medida está defasada', '03:00:00'::interval,
                (SELECT max(log.iniciada_em) FROM log WHERE log.fonte = 'observacao+alerta' AND log.erro !~~* '%alertario%')
        UNION ALL
         SELECT 3, 'cemaden', 'Chuva medida (CEMADEN)', 'a chuva medida está defasada', '03:00:00'::interval,
                (SELECT max(log.iniciada_em) FROM log WHERE log.fonte = 'cemaden' AND log.ok)
        UNION ALL
         SELECT 4, 'inmet', 'Avisos do INMET', 'podem faltar avisos oficiais', '03:00:00'::interval,
                (SELECT max(log.iniciada_em) FROM log WHERE log.fonte = 'observacao+alerta' AND log.erro !~~* '%inmet%')
        UNION ALL
         SELECT 5, 'defesa_civil', 'Risco da Defesa Civil', 'o risco da Defesa Civil pode estar desatualizado', '03:00:00'::interval,
                (SELECT max(log.iniciada_em) FROM log WHERE log.fonte = 'observacao+alerta' AND log.erro !~~* '%risco%')
        UNION ALL
         SELECT 7, 'trovoada', 'Trovoada (REDEMET)', 'o aviso de trovoada está parado', '00:30:00'::interval,
                (SELECT max(log.iniciada_em) FROM log WHERE log.fonte = 'trovoada' AND log.ok)
        ), s AS (
         SELECT f.*, (f.ultima_ok IS NULL OR (now() - f.ultima_ok) > f.tolerancia) AS atrasada FROM f
        ), cem AS (
         SELECT s_1.atrasada AS parado FROM s s_1 WHERE s_1.chave = 'cemaden'
        )
 SELECT ordem, chave, rotulo, efeito, ultima_ok,
        round(EXTRACT(epoch FROM now() - ultima_ok) / 3600::numeric, 1) AS horas,
        atrasada,
        CASE WHEN chave = 'alertario' THEN atrasada AND (SELECT cem.parado FROM cem) ELSE atrasada END AS no_topo,
        CASE WHEN chave = 'alertario' AND atrasada AND NOT (SELECT cem.parado FROM cem)
             THEN 'o Rio segue medido pelos pluviômetros do CEMADEN' END AS obs
   FROM s
  ORDER BY ordem;
