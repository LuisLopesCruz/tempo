-- 090: avisos do bot a cada 6 min, 1 min depois da coleta da trovoada.
select cron.schedule('tempo_telegram_avisos', '1-59/6 * * * *', $$select tempo.disparar_telegram('avisos');$$);
-- 091: tempo_tg_plano_trovoada recriada com a variavel v_nivel. A versao do
-- 089 chamava a variavel de "nivel", o mesmo nome da coluna da tabela, e o
-- UPDATE falhou com "column reference nivel is ambiguous" na primeira rodada
-- (07/11, 23h31). Texto integral corrigido em 089_telegram.sql.
