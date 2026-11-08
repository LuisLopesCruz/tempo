-- ============================================================================
-- 088 — Liga a coleta de trovoada (a cada 6 min) e a poe no monitor de saude.
-- Separado do 087 de proposito: o cron so foi ligado depois de a Edge Function
-- estar publicada e de uma coleta manual ter dado 92 municipios (07/11, 22h41).
-- ============================================================================
select cron.schedule('tempo_coletar_trovoada', '*/6 * * * *', 'select tempo.disparar_trovoada();');

-- tempo_saude: mesma view da 086, com a linha 7. Tolerancia de 30 min porque
-- aviso de curtissimo prazo parado meia hora ja nao serve para nada.
-- (create or replace mantem os grants; colunas inalteradas)
--   UNION ALL
--    SELECT 7, 'trovoada', 'Trovoada (REDEMET)', 'o aviso de trovoada está parado',
--       '00:30:00'::interval,
--       (SELECT max(log.iniciada_em) FROM log WHERE log.fonte = 'trovoada' AND log.ok)
-- O texto integral aplicado esta no historico de migrations do Supabase
-- (088_trovoada_cron_saude).
