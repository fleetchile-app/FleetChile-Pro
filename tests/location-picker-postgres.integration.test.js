'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {embedded,harness}=require('./helpers/acceptance'),{registerLocationPickerRoutes}=require('../location-picker-api'),{bindLocations}=require('../location-binding');
test('ubicaciones SQL: catálogo, aislamiento, rutas y auditoría transaccional',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const runtime=await embedded();try{
  const {pool}=runtime,h=await harness(pool),a=await h.company('Ubicaciones sintéticas A'),b=await h.company('Ubicaciones sintéticas B');
  const routes=[],app={};for(const method of ['get','post'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
  const routeData={distance_meters:1234,duration_seconds:600,provider:'synthetic-test-only',calculated_at:new Date().toISOString(),geometry:{type:'LineString',coordinates:[[-73,-36],[-70,-33]]},snapped_points:[{lat:-36,lng:-73,distance:0},{lat:-33,lng:-70,distance:0}]};
  registerLocationPickerRoutes(app,pool,{search:async()=>[]},{route:async()=>routeData},{env:{GEOCODING_BASE_URL:'https://geocode.example.invalid',ROUTING_BASE_URL:'https://route.example.invalid'}});
  const run=async(method,name,body={},cid=a.id,query={})=>{const req={body,query,user:{id:a.admin.id,actor_type:'company',scope:'company',company_id:cid,role_code:'company_admin',permissions:['trips.manage']},ip:'127.0.0.1'},res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;}};const route=routes.find(r=>r.method===method&&r.path==='/api/location-picker/'+name);async function next(i){let work;if(route.handlers[i]){await route.handlers[i](req,res,()=>work=next(i+1));if(work)await work;}}await next(0);return res;};
  const geo=await h.one('select c.id,p.region_id from geo_communes c join geo_provinces p on p.id=c.province_id order by c.id limit 1'),locality=await h.one('select id from geo_localities where commune_id=$1 limit 1',[geo.id]);
  const body={name:'Acceso planta sintética',commune_id:Number(geo.id),region_id:Number(geo.region_id),lat:-36,lng:-73,address:'Punto sintético, no usar para planificar',access_notes:'Portón de prueba'};
  let origin,destination,road;
  await t.test('migración INE carga 9378 topónimos y es idempotente',async()=>{
   assert.equal((await h.one("select count(*)::int n from geo_localities where source='INE Censo de Poblacion y Vivienda 2024'")).n,9378);const seed=fs.readFileSync(require.resolve('../migrations/044_seed_ine_localities_2024.sql'),'utf8');await pool.query(seed.slice(seed.indexOf('INSERT INTO'),seed.lastIndexOf('COMMIT;')));assert.equal((await h.one('select count(*)::int n from geo_localities')).n,9378);
  });
  await t.test('guardar punto valida jerarquía y registra actor/auditoría',async()=>{
   const bad=await run('post','locations',{...body,region_id:999});assert.equal(bad.statusCode,400);if(locality){const other=await h.one('select id from geo_localities where commune_id<>$1 limit 1',[geo.id]);assert.equal((await run('post','locations',{...body,locality_id:Number(other.id)})).statusCode,400);}
   let r=await run('post','locations',body);assert.equal(r.statusCode,201,JSON.stringify(r.payload));origin=r.payload;assert.equal(Number(origin.created_by),a.admin.id);assert.equal(origin.access_notes,body.access_notes);
   r=await run('post','locations',{...body,name:'Destino sintético',lat:-33,lng:-70});assert.equal(r.statusCode,201);destination=r.payload;
   assert.equal((await h.one("select count(*)::int n from audit_logs where entity='operational_location' and company_id=$1",[a.id])).n,2);
  });
  await t.test('no mezcla ubicaciones ni cálculos de otra empresa',async()=>{
   assert.equal((await run('get','locations',{},b.id)).payload.length,0);const foreign=(await run('post','locations',{...body,name:'Punto otra empresa'},b.id)).payload;
   assert.equal((await run('post','route',{origin_location_id:origin.id,destination_location_id:foreign.id})).statusCode,404);
   const r=await run('post','route',{origin_location_id:origin.id,destination_location_id:destination.id});assert.equal(r.statusCode,201,JSON.stringify(r.payload));road=r.payload;
  });
  await t.test('viaje nuevo conserva referencias y snapshot con kilómetros del servidor, no del formulario',async()=>{
   const client=await h.one("insert into clients(company_id,name) values($1,'Cliente de prueba') returning id",[a.id]);
   const response=await h.run(a.admin.token,'post','/api/trips',{body:{client_id:Number(client.id),origin:origin.name,destination:destination.name,origin_location_id:Number(origin.id),destination_location_id:Number(destination.id),road_route_id:Number(road.id),distance_km:99999}});
   assert.equal(response.statusCode,201,JSON.stringify(response.payload));assert.equal(Number(response.payload.distance_km),1.234);assert.ok(response.payload.planned_route_snapshot_id);assert.equal(Number(response.payload.origin_location_id),Number(origin.id));
   const snapshot=await h.one('select * from trip_route_snapshots where id=$1',[response.payload.planned_route_snapshot_id]);assert.equal(Number(snapshot.distance_meters),1234);
   const bad=await h.run(b.admin.token,'post','/api/trips',{body:{client_id:Number((await h.one("insert into clients(company_id,name) values($1,'Otro cliente') returning id",[b.id])).id),origin:'X',destination:'Y',origin_location_id:Number(origin.id),destination_location_id:Number(destination.id)}});assert.equal(bad.statusCode,400);
  });
  await t.test('fallo de auditoría revierte la creación del punto',async()=>{
   await pool.query("CREATE FUNCTION location_fail_audit() RETURNS trigger AS $$ BEGIN IF NEW.entity='operational_location' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;");await pool.query('CREATE TRIGGER location_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION location_fail_audit()');
   try{assert.equal((await run('post','locations',{...body,name:'No debe persistir'})).statusCode,400);assert.equal((await h.one("select count(*)::int n from operational_locations where name='No debe persistir'")).n,0);}finally{await pool.query('DROP TRIGGER location_fail_audit ON audit_logs');}
  });
  await t.test('distancia pendiente permanece desconocida, no cero',async()=>{
   const r=await h.one("insert into routes(company_id,origin,destination,distance_km) values($1,'X','Y',0) returning *",[a.id]);const db=await pool.connect();try{await db.query('BEGIN');const bound=await bindLocations(db,'routes',r,{origin_location_id:origin.id,destination_location_id:destination.id},a.id);assert.equal(bound.distance_km,null);await db.query('COMMIT');}finally{db.release();}
  });
 }finally{await runtime.close();}
});
