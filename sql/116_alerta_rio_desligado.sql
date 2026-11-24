-- 116 — Alerta Rio DESLIGADO (pedido do usuario, 24/11: "cancelar a validacao do
-- Alerta Rio, pois se nao temos dados desde 22/10, nao faz sentido ficar buscando").
--
-- Desde 22/10 ~21h UTC a fonte devolve a pagina HTML do firewall da prefeitura:
-- 730 rodadas seguidas com falha ate 24/11. A coleta saiu da funcao
-- tempo-coletar-observacao (v13). Efeito que importava: toda rodada do coletor
-- de observacao ficava "ok = false" no coleta_log, e um erro de verdade do INMET
-- ou da Defesa Civil se escondia no meio.
--
-- Aqui: a linha "Chuva medida (Alerta Rio)" sai do monitor de saude. Sem isso
-- ela passaria a aparecer EM DIA — o monitor media o Alerta Rio pela ausencia
-- do texto 'alertario' no erro, e esse texto nao aparece mais.
--
-- O que fica como esta, de proposito:
--  * os 19.376 pares de verificacao do Alerta Rio (ate 22/10): sao medicao real,
--    ja recalculados pela media (sql/113); entram em pesos e calibracao como
--    qualquer outro par. Representam 2,7% dos pares.
--  * a preferencia por 'alerta-rio' em obs_horaria/verificar/boletim/alertas:
--    sem dado novo, ela nao escolhe nada; o Rio ja vinha so pelo CEMADEN.

create or replace view public.tempo_saude as
 with log as (
   select coleta_log.fonte, coleta_log.iniciada_em, coleta_log.ok,
          coalesce(coleta_log.erro, ''::text) as erro
     from tempo.coleta_log
    where coleta_log.iniciada_em > (now() - '7 days'::interval)
 ), f as (
   select 1 as ordem, 'previsao'::text as chave, 'Previsão dos modelos'::text as rotulo,
          'a previsão está defasada'::text as efeito, '07:00:00'::interval as tolerancia,
          (select max(previsao.coletada_em) from tempo.previsao) as ultima_ok
   union all
   select 3, 'cemaden', 'Chuva medida (CEMADEN)', 'a chuva medida está defasada', '03:00:00'::interval,
          (select max(log.iniciada_em) from log where log.fonte = 'cemaden' and log.ok)
   union all
   select 4, 'inmet', 'Avisos do INMET', 'podem faltar avisos oficiais', '03:00:00'::interval,
          (select max(log.iniciada_em) from log where log.fonte = 'observacao+alerta' and log.erro !~~* '%inmet%')
   union all
   select 5, 'defesa_civil', 'Risco da Defesa Civil', 'o risco da Defesa Civil pode estar desatualizado', '03:00:00'::interval,
          (select max(log.iniciada_em) from log where log.fonte = 'observacao+alerta' and log.erro !~~* '%risco%')
   union all
   select 7, 'trovoada', 'Trovoada (REDEMET)', 'o aviso de trovoada está parado', '00:30:00'::interval,
          (select max(log.iniciada_em) from log where log.fonte = 'trovoada' and log.ok)
 ), s as (
   select f.*, (f.ultima_ok is null or (now() - f.ultima_ok) > f.tolerancia) as atrasada from f
 )
 select ordem, chave, rotulo, efeito, ultima_ok,
        round(extract(epoch from (now() - ultima_ok)) / 3600::numeric, 1) as horas,
        atrasada,
        atrasada as no_topo,
        null::text as obs
   from s
  order by ordem;
