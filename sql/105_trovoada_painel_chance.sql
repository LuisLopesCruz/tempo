-- 105 — Painel: "A caminho" vira "Trovoada proxima" (pedido do usuario, 15/11)
-- e a linha passa a mostrar a chance APRENDIDA de chegar (sql/101), como o bot.
-- A view publica ganha a coluna chance no fim (create or replace so aceita
-- coluna nova no final).
create or replace view public.tempo_trovoada as
 SELECT municipio_ibge,
        CASE WHEN quadro < (now() - '00:30:00'::interval) THEN 'sem_dado'::text ELSE situacao END AS situacao,
        dist_km, velocidade_kmh, chegada_em, celulas_50km, quadro, desde, vem_de,
        chance
   FROM tempo.trovoada_estado;
