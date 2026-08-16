INSERT INTO trucks(patente,tipo,capacidad_t,driver,status,km,lat,lng,location) VALUES
('LJ-KP-82','Tractocamión',28,'Carlos Muñoz','En ruta',184220,-36.6067,-72.1034,'Chillán'),
('PD-HF-31','Camión 3/4',8,'María Soto','Disponible',96340,-36.82699,-73.04977,'Concepción'),
('RK-JS-44','Tractocamión',30,'Luis Rojas','En ruta',227110,-38.7359,-72.5904,'Temuco'),
('GT-PL-17','Rampla',25,NULL,'Mantención',301550,-33.4489,-70.6693,'Santiago')
ON CONFLICT (patente) DO NOTHING;
INSERT INTO drivers(name,rut,license,expiry) VALUES
('Carlos Muñoz','12.345.678-5','A5','2027-04-12'),
('María Soto','15.234.567-1','A5','2026-12-08'),
('Luis Rojas','11.456.789-2','A5','2027-09-21');
INSERT INTO routes(truck,origin,destination,distance_km,progress,status) VALUES
('LJ-KP-82','Santiago','Puerto Montt',1030,62,'En ruta'),
('RK-JS-44','Santiago','Temuco',675,81,'En ruta'),
('PD-HF-31','Concepción','Los Ángeles',115,0,'Planificada');
INSERT INTO loads(client,guide,cargo,weight_kg,volume_m3,value_clp,truck,origin,destination,status) VALUES
('Alimentos del Sur SpA','GD-2026-000812','Productos alimenticios',18400,72,22000000,'LJ-KP-82','Santiago','Puerto Montt','En tránsito'),
('Maderas BioBío Ltda.','GD-2026-000813','Madera aserrada',22100,64,18500000,'RK-JS-44','Santiago','Temuco','En tránsito'),
('Comercial Andina','GD-2026-000814','Insumos',4200,18,4200000,'PD-HF-31','Concepción','Los Ángeles','Planificada');
INSERT INTO maintenance(truck,item,due,cost_clp,status) VALUES
('GT-PL-17','Servicio 300.000 km','2026-08-18',1240000,'Pendiente'),
('LJ-KP-82','Cambio de aceite','2026-08-29',185000,'Programada');
INSERT INTO fuel(date,truck,liters,price_clp,total_clp,station) VALUES
('2026-08-15','LJ-KP-82',420,1240,520800,'Copec Ruta 5'),
('2026-08-15','RK-JS-44',350,1255,439250,'Shell Temuco');
INSERT INTO alerts(level,title,text) VALUES
('amber','Mantención próxima','GT-PL-17 requiere servicio de 300.000 km el 18/08/2026.'),
('red','Entrega atrasada','C-7003 requiere revisión operacional.'),
('blue','GPS sin señal','Configura el proveedor telemático del vehículo para recibir posición real.');
