-- 113 — Chuva observada por municipio passa da MEDIANA para a MEDIA das estacoes
-- (pedido do usuario, 22/11: "estuda antes de trocar a mediana" -> "Pode trocar").
--
-- Estudo (22/11, CEMADEN 11/09-22/11, 72 municipios; pares 0-6h da verificacao):
--  * a mediana so registra chuva quando MAIS DA METADE das estacoes molha. Em
--    municipios com 10+ estacoes (Petropolis, Rio...), de 238 horas com alguma
--    estacao >= 10 mm, a mediana deu "nao choveu" em 118 (50%); com >= 20 mm,
--    em 40 de 69 (58%). Com 3-4 estacoes, 19%. Caso real: Petropolis 22/11,
--    17h — 26,6 mm numa estacao, mediana das 17 = 0.
--  * pesos dos modelos: a ordem (ICON, ARPEGE, GFS, ECMWF, CMA, UKMO, JMA, GEM)
--    e a mesma pela mediana e pela media; o MAE muda no 3o decimal.
--  * chance de chuva: com 6 de 8 familias prevendo chuva, choveu em 23% das
--    horas pela mediana e 26% pela media; nos municipios com 10+ estacoes,
--    23% contra 44% (com 8 de 8: 46% contra 64%). A chance aprendida saia
--    metade da real justo nas cidades grandes.
--  * por que a MEDIA e nao a estacao mais molhada: o modelo preve a chuva media
--    de uma area — a media das estacoes e a mesma grandeza e nao depende de
--    quantas estacoes o municipio tem. A mais molhada cresce com o tamanho da
--    rede (com 10+ estacoes, "chove" em 39% das horas; com 3-4, em 12%).
--    Ela fica disponivel como observado_max (para aviso, se decidido).
--
-- Efeito colateral a saber: o aviso de "chuva forte medida" (>= 30 mm/h ou
-- >= 50 mm/24 h, tempo_tg_plano_alertas) le esta mesma view, e passa da mediana
-- para a media.
--
-- Os pares dos ultimos 45 dias sao recalculados, para pesos e calibracao mudarem
-- de uma vez (so as linhas cujo valor muda; erro e coluna gerada).

create or replace view tempo.obs_horaria as
 SELECT o.ponto_id,
    date_trunc('hour'::text, o.medido_em) AS hora,
    avg(o.valor::double precision) AS observado,
    'alerta-rio'::text AS fonte,
    count(*)::integer AS n_estacoes,
    max(o.valor::double precision) AS observado_max
   FROM tempo.observacao o
  WHERE o.variavel = 'precip_1h'::text AND o.ponto_id IS NOT NULL
  GROUP BY o.ponto_id, (date_trunc('hour'::text, o.medido_em))
UNION ALL
 SELECT d.ponto_id,
    (d.dia + make_interval(hours => i.i - 1)) AT TIME ZONE 'America/Sao_Paulo'::text AS hora,
    d.chuva_h[i.i]::double precision AS observado,
    d.fonte,
    d.n_estacoes[i.i]::integer AS n_estacoes,
    d.chuva_h_max[i.i]::double precision AS observado_max
   FROM tempo.observacao_dia d
     CROSS JOIN generate_series(1, 24) i(i)
  WHERE d.chuva_h[i.i] IS NOT NULL;

-- recalculo dos pares ja verificados: CEMADEN
update tempo.verificacao v set observado = x.media
  from (select v2.id, d.chuva_h[extract(hour from v2.valido_em at time zone 'America/Sao_Paulo')::int + 1] as media
          from tempo.verificacao v2
          join tempo.observacao_dia d on d.ponto_id = v2.ponto_id
                                     and d.dia = (v2.valido_em at time zone 'America/Sao_Paulo')::date
         where v2.fonte_obs = 'cemaden') x
 where v.id = x.id and x.media is not null and v.observado is distinct from x.media;

-- recalculo dos pares ja verificados: Alerta Rio
update tempo.verificacao v set observado = x.media
  from (select o.ponto_id, date_trunc('hour', o.medido_em) as hora, avg(o.valor) as media
          from tempo.observacao o
         where o.variavel = 'precip_1h' and o.ponto_id is not null
         group by 1, 2) x
 where v.fonte_obs = 'alerta-rio' and v.ponto_id = x.ponto_id and v.valido_em = x.hora
   and v.observado is distinct from x.media;

-- pesos e calibracao refeitos ja com a media
select tempo.atualizar_skill();
select tempo.atualizar_calibracao();
