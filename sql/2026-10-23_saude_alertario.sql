-- O aviso do Alerta Rio no topo do painel dizia "a chuva medida esta defasada",
-- o que deixou de ser verdade: tempo.verificar() prefere 'alerta-rio' mas cai
-- para o CEMADEN no mesmo ponto quando ele falta (desde o bloqueio por WAF de
-- 2026-10-22 21h UTC, 100% dos pares do Rio vem do CEMADEN). O efeito real e
-- menos estacoes na cidade do Rio, nao falta de dado. So o texto muda.
create or replace view public.tempo_saude as
 WITH log AS (
         SELECT coleta_log.fonte,
            coleta_log.iniciada_em,
            coleta_log.ok,
            COALESCE(coleta_log.erro, ''::text) AS erro
           FROM tempo.coleta_log
          WHERE coleta_log.iniciada_em > (now() - '7 days'::interval)
        ), f AS (
         SELECT 1 AS ordem,
            'previsao'::text AS chave,
            'Previsão dos modelos'::text AS rotulo,
            'a previsão está defasada'::text AS efeito,
            '07:00:00'::interval AS tolerancia,
            ( SELECT max(previsao.coletada_em) AS max
                   FROM tempo.previsao) AS ultima_ok
        UNION ALL
         SELECT 2,
            'alertario'::text,
            'Chuva medida (Alerta Rio)'::text,
            'a cidade do Rio usa só os pluviômetros do CEMADEN (menos estações)'::text,
            '03:00:00'::interval AS "interval",
            ( SELECT max(log.iniciada_em) AS max
                   FROM log
                  WHERE log.fonte = 'observacao+alerta'::text AND log.erro !~~* '%alertario%'::text) AS max
        UNION ALL
         SELECT 3,
            'cemaden'::text,
            'Chuva medida (CEMADEN)'::text,
            'a chuva medida está defasada'::text,
            '03:00:00'::interval AS "interval",
            ( SELECT max(log.iniciada_em) AS max
                   FROM log
                  WHERE log.fonte = 'cemaden'::text AND log.ok) AS max
        UNION ALL
         SELECT 4,
            'inmet'::text,
            'Avisos do INMET'::text,
            'podem faltar avisos oficiais'::text,
            '03:00:00'::interval AS "interval",
            ( SELECT max(log.iniciada_em) AS max
                   FROM log
                  WHERE log.fonte = 'observacao+alerta'::text AND log.erro !~~* '%inmet%'::text) AS max
        UNION ALL
         SELECT 5,
            'defesa_civil'::text,
            'Risco da Defesa Civil'::text,
            'o risco da Defesa Civil pode estar desatualizado'::text,
            '03:00:00'::interval AS "interval",
            ( SELECT max(log.iniciada_em) AS max
                   FROM log
                  WHERE log.fonte = 'observacao+alerta'::text AND log.erro !~~* '%risco%'::text) AS max
        UNION ALL
         SELECT 6,
            'aneel'::text,
            'Robô da ANEEL'::text,
            'a carga das ocorrências da ANEEL parou'::text,
            '36:00:00'::interval AS "interval",
            ( SELECT max(log.iniciada_em) AS max
                   FROM log
                  WHERE log.fonte = 'aneel-github'::text AND log.ok) AS max
        )
 SELECT ordem,
    chave,
    rotulo,
    efeito,
    ultima_ok,
    round(EXTRACT(epoch FROM now() - ultima_ok) / 3600::numeric, 1) AS horas,
    ultima_ok IS NULL OR (now() - ultima_ok) > tolerancia AS atrasada
   FROM f
  ORDER BY ordem;
