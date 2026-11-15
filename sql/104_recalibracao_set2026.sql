-- 104 — RECALIBRACAO DO IMPACTO COM SETEMBRO/2026 (pedido do usuario, 15/11:
-- "Pode recalibrar o modelo com setembro"). Gerado por calibracao/3_ajustar_v4.py
-- sobre 2023-2026 ate 30/09/2026 (arquivo da ANEEL de 12/11), 125.948
-- municipio-dia. Corrige tambem os dias com tempo e sem ANEEL que entravam como
-- "zero chamados" (2_montar_painel.py). Conferencias do roteiro: b monotonico
-- (salvo CAPE 200-500 = -0,005, ruido ja registrado), vies +0,04, alcance 38 de
-- 92 municipios, curva monotonica terminando em 31,4%.
-- Reversao: sql/104_reverter_calibracao_set11.sql.

-- gerado por 3_ajustar_v4.py
-- anos [2023, 2024, 2025, 2026] | 125,948 municipio-dia | vies +0.04

truncate tempo.impacto_coef_v4;
insert into tempo.impacto_coef_v4 (causa,driver,faixa,minimo,maximo,b,n_dias) values
('vento','rajada_kmh','<30',0,30,0.0000,57081),
('vento','rajada_kmh','30-40',30,40,0.0417,43794),
('vento','rajada_kmh','40-50',40,50,0.1076,19017),
('vento','rajada_kmh','50-60',50,60,0.1966,4902),
('vento','rajada_kmh','60-70',60,70,0.3497,976),
('vento','rajada_kmh','>=70',70,null,0.6694,178),
('raio','chuva_h_max_mm','<1',0,1,0.0000,91360),
('raio','chuva_h_max_mm','1-3',1,3,0.1552,18087),
('raio','chuva_h_max_mm','3-6',3,6,0.2161,9744),
('raio','chuva_h_max_mm','6-12',6,12,0.2813,5584),
('raio','chuva_h_max_mm','>=12',12,null,0.3761,1173),
('conveccao','cape_jkg','<200',0,200,0.0000,50383),
('conveccao','cape_jkg','200-500',200,500,-0.0052,17799),
('conveccao','cape_jkg','500-1k',500,1000,0.0577,19894),
('conveccao','cape_jkg','1k-2k',1000,2000,0.1270,25647),
('conveccao','cape_jkg','>=2k',2000,null,0.1945,12225);

truncate tempo.impacto_prob_v4;
insert into tempo.impacto_prob_v4 (rel_min,rel_max,prob,n_dias) values
(0.0,1.0,0.0402,26323),
(1.0,1.1,0.0571,19746),
(1.1,1.2,0.0713,31569),
(1.2,1.3,0.1154,19501),
(1.3,1.4,0.1598,13232),
(1.4,1.6,0.2318,13210),
(1.6,null,0.3139,2367);

truncate tempo.impacto_dow;
insert into tempo.impacto_dow (dow,fator) values
(1,1.1533),(2,1.0919),(3,1.1097),(4,1.0765),(5,1.0389),(6,0.8263),(0,0.7108)
on conflict (dow) do update set fator = excluded.fator;

-- base por municipio — nivel do ano 2025 (ano COMPLETO mais recente).
-- Coeficientes vem de todos os anos; o NIVEL vem de um ano so.
update tempo.impacto_baseline b set base_total = v.base from (values
(3300100,51.25),
(3300159,2.33),
(3300209,28.25),
(3300225,3.07),
(3300233,13.76),
(3300258,15.67),
(3300308,15.72),
(3300407,18.62),
(3300456,44.47),
(3300506,8.07),
(3300605,6.23),
(3300704,54.74),
(3300803,6.71),
(3300902,2.73),
(3300936,5.17),
(3300951,1.42),
(3301009,60.00),
(3301108,7.57),
(3301157,6.31),
(3301207,2.94),
(3301306,12.46),
(3301405,4.41),
(3301504,5.17),
(3301603,4.65),
(3301702,117.56),
(3301801,4.27),
(3301850,13.34),
(3301876,7.74),
(3301900,26.59),
(3302007,22.52),
(3302056,3.51),
(3302106,5.83),
(3302205,19.95),
(3302254,5.14),
(3302270,8.09),
(3302304,2.03),
(3302403,44.91),
(3302452,1.57),
(3302502,34.89),
(3302601,24.35),
(3302700,48.90),
(3302809,6.59),
(3302858,20.64),
(3302908,7.86),
(3303005,4.71),
(3303104,3.68),
(3303203,20.73),
(3303302,53.35),
(3303401,27.75),
(3303500,125.07),
(3303609,7.17),
(3303708,9.56),
(3303807,22.97),
(3303856,6.63),
(3303906,51.61),
(3303955,3.34),
(3304003,8.51),
(3304102,3.08),
(3304110,2.83),
(3304128,2.44),
(3304144,15.54),
(3304151,6.71),
(3304201,15.73),
(3304300,9.36),
(3304409,5.30),
(3304508,2.32),
(3304524,45.64),
(3304557,729.77),
(3304607,4.12),
(3304706,8.08),
(3304755,14.56),
(3304805,7.95),
(3304904,85.28),
(3305000,11.47),
(3305109,52.10),
(3305133,2.00),
(3305158,4.51),
(3305208,21.48),
(3305307,2.79),
(3305406,4.03),
(3305505,28.26),
(3305554,14.55),
(3305604,6.12),
(3305703,4.45),
(3305752,5.20),
(3305802,27.80),
(3305901,4.00),
(3306008,11.48),
(3306107,16.86),
(3306156,2.86),
(3306206,7.98),
(3306305,28.89)
) as v(ibge,base) where b.municipio_ibge = v.ibge;

-- marca a fonte como ja calibrada, para o vigia de quarta nao acusar falso positivo
update tempo.fonte_externa set calibrado_em = now()
 where fonte='aneel_ocorrencias' and rotulo in ('2023','2024','2025','2026');

-- o limiar de "dia ruim" tem de casar com a calibracao que gerou impacto_prob_v4
update tempo.impacto_param set valor = 2.18,
  nota = 'chamados / base >= isto = dia ruim. p90 da distribuicao de 2023-2026 (ate 30/09/2026). Tem de casar com a calibracao que gerou impacto_prob_v4.'
 where chave = 'limiar_dia_ruim';
-- o rodape do painel deixa de acusar setembro como "nao incorporado"
update tempo.aneel_arquivo set calibrado_ate = '2026-09-30' where id;
-- reescore da verificacao de setembro com o limiar novo, e o risco em vigor ja recalculado
select * from tempo.impacto_pontuar();
select tempo.atualizar_risco();
