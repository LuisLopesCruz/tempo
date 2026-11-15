-- 104 (REVERSAO) — volta a calibracao do impacto ao estado de 11/09/2026
-- (anos 2023-2026 ate ~05/09, 123.648 municipio-dia, limiar 2,19). Guardado em
-- 15/11 antes de aplicar a recalibracao com setembro (sql/104). So aplicar se
-- a nova calibracao precisar ser desfeita. A base por municipio (nivel de 2025)
-- nao muda entre as duas, entao nao entra aqui.
truncate tempo.impacto_coef_v4;
insert into tempo.impacto_coef_v4 (causa,driver,faixa,minimo,maximo,b,n_dias) values
('conveccao','cape_jkg','<200',0,200,0,49646),
('conveccao','cape_jkg','200-500',200,500,-0.0067,17441),
('conveccao','cape_jkg','500-1k',500,1000,0.0594,19573),
('conveccao','cape_jkg','1k-2k',1000,2000,0.1394,25149),
('conveccao','cape_jkg','>=2k',2000,null,0.1799,11839),
('raio','chuva_h_max_mm','<1',0,1,0,90184),
('raio','chuva_h_max_mm','1-3',1,3,0.162,17380),
('raio','chuva_h_max_mm','3-6',3,6,0.1906,9456),
('raio','chuva_h_max_mm','6-12',6,12,0.275,5463),
('raio','chuva_h_max_mm','>=12',12,null,0.309,1165),
('vento','rajada_kmh','<30',0,30,0,56159),
('vento','rajada_kmh','30-40',30,40,0.0449,42981),
('vento','rajada_kmh','40-50',40,50,0.1162,18628),
('vento','rajada_kmh','50-60',50,60,0.1899,4757),
('vento','rajada_kmh','60-70',60,70,0.3047,946),
('vento','rajada_kmh','>=70',70,null,0.586,177);
truncate tempo.impacto_prob_v4;
insert into tempo.impacto_prob_v4 (rel_min,rel_max,prob,n_dias) values
(0,1,0.0367,23247),(1,1.1,0.0575,24519),(1.1,1.2,0.0725,28760),(1.2,1.3,0.1194,19992),
(1.3,1.4,0.1651,12756),(1.4,1.6,0.2364,12991),(1.6,null,0.3377,1383);
insert into tempo.impacto_dow (dow,fator) values
(0,0.7143),(1,1.1481),(2,1.0794),(3,1.0841),(4,1.0671),(5,1.0506),(6,0.8658)
on conflict (dow) do update set fator = excluded.fator;
update tempo.impacto_param set valor = 2.19 where chave = 'limiar_dia_ruim';
update tempo.aneel_arquivo set calibrado_ate = '2026-08-31' where id;
select * from tempo.impacto_pontuar();
