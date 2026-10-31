'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {MIGRATION_FILES}=require('../startup');
const {registerOperationalOutings}=require('../operational-outings');
const {registerEquipmentRoutes}=require('../equipment-api');
const {assertTripAvailability}=require('../trip-availability');
test('salida P1: link sin recursos y reemplazo PL15 con esquema y readiness reales',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async()=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),pg=new PGlite();
 const query=async(sql,v=[])=>{const r=await pg.query(sql,v);return {...r,rowCount:r.rows.length||r.affectedRows||0};};
 const one=async(sql,v)=>(await query(sql,v)).rows[0],pool={query,connect:async()=>({query,release(){}})};
 const source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
 try{
  await pg.exec(source('schema.sql'));await pg.exec(source('migrations/002_core_platform.sql'));
  for(const m of MIGRATION_FILES)await pg.exec(source('migrations/'+m));
  const cid=(await one("insert into companies(legal_name) values('Salida P1 fixture') returning id")).id;
  const role=await one("select id from roles where code='company_admin'"),drRole=await one("select id from roles where code='driver'");
  const user=await one("insert into users(company_id,role_id,name,email) values($1,$2,'Operador P1','outing-p1@example.invalid') returning id",[cid,role.id]);
  const actor={id:user.id,name:'Operador P1',actor_type:'company',scope:'company',company_id:cid,membership_id:1,permissions:['trips.manage']};
  const client=await one("insert into clients(company_id,name) values($1,'Cliente sintético') returning id",[cid]);
  async function truck(plate,type){
   const t=await one('insert into trucks(company_id,patente,tipo,capacidad_t) values($1,$2,$3,15) returning *',[cid,plate,type]);
   for(const doc of ['Permiso de circulación','SOAP','Revisión técnica'])await query("insert into vehicle_documents(truck_id,document_type,expires_at,status) values($1,$2,'2099-12-31','Vigente')",[t.id,doc]);
   return t;
  }
  const main=await truck('OUT-P1-A','Tractocamión'),trailer=await truck('OUT-P1-R','Semirremolque'),replacement=await truck('OUT-P1-B','Tractocamión');
  const d=await one("insert into drivers(company_id,name,status,operational_registered_at) values($1,'Conductor P1','Activo',now()) returning id",[cid]);
  const du=await one("insert into users(company_id,driver_id,role_id,name,email) values($1,$2,$3,'Conductor P1','outing-driver-p1@example.invalid') returning id",[cid,d.id,drRole.id]);
  const dm=await one('insert into user_memberships(company_id,user_id,role_id) values($1,$2,$3) returning id',[cid,du.id,drRole.id]);
  const person=await one("insert into company_people(company_id,user_id,membership_id,driver_id,name,rut,birth_date) values($1,$2,$3,$4,'Conductor P1','10000000-8','1990-01-01') returning id",[cid,du.id,dm.id,d.id]);
  await query("insert into person_contracts(company_id,person_id,type,start_date) values($1,$2,'indefinite','2000-01-01')",[cid,person.id]);
  await query("insert into person_driver_licenses(company_id,person_id,classes,printed_expiry,effective_expiry) values($1,$2,ARRAY['A5'],'2099-12-31','2099-12-31')",[cid,person.id]);
  const locations=[];
  for(const name of ['Base fixture','Origen fixture','Destino fixture'])locations.push(await one("insert into operational_locations(company_id,name,lat,lng,source) values($1,$2,-33,-70,'manual') returning id",[cid,name]));
  async function trip(number,origin,destination,day){return one(`insert into trips(company_id,trip_number,client_id,status,origin,destination,origin_location_id,destination_location_id,planned_departure,planned_arrival)
   values($1,$2,$3,'Planificado','Origen fixture','Destino fixture',$4,$5,now()+$6::integer*interval '1 day',now()+($6::integer+1)*interval '1 day') returning *`,[cid,number,client.id,origin.id,destination.id,day]);}
  const first=await trip('OUT-P1-1',locations[1],locations[2],2),next=await trip('OUT-P1-2',locations[2],locations[1],4);
  const routes=new Map(),app={};for(const method of ['get','post','patch'])app[method]=(p,...h)=>routes.set(method+' '+p,h);
  registerEquipmentRoutes(app,pool);registerOperationalOutings(app,pool,{driverAccess:()=>true,enforceDriverPersonnel:async()=>true});
  async function run(method,url,id,body){
   const req={user:actor,params:{id:String(id)},body:body||{},query:{},ip:'127.0.0.1'},res={statusCode:200,status(c){this.statusCode=c;return this;},json(payload){this.payload=payload;this.sent=true;return this;}};
   for(const h of routes.get(method+' '+url)){let next=false;await h(req,res,()=>{next=true;});if(res.sent||!next)break;}return res;
  }
  const resource='/api/operations/trips/:id/resources',outing='/api/operations/trips/:id/outing';
  const desired=(truck,version)=>({resource_version:version,composition_id:null,truck_id:truck.id,trailer_id:trailer.id,driver_id:d.id,client_id:client.id,route_id:null,reason:'Asignación sintética trazable'});
  let r=await run('patch',resource,first.id,desired(main,0));assert.equal(r.statusCode,200,JSON.stringify(r.payload));
  r=await run('post',outing,first.id,{base_location_id:locations[0].id,reason:'Inicio de salida P1'});assert.equal(r.statusCode,201,JSON.stringify(r.payload));
  const outingId=r.payload.outing.id;
  await query("update trips set status='Completado' where id=$1",[first.id]);
  r=await run('patch',resource,next.id,desired(main,0));assert.equal(r.statusCode,409,'La reserva impide asignación fuera del link');
  assert.equal((await one('select resource_version from trips where id=$1',[next.id])).resource_version,0);
  r=await run('post',outing+'/action',first.id,{version:1,action:'link',next_trip_id:next.id,reason:'Continuidad con traslado vacío inicial'});
  assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(r.payload.outing.version,2);assert.equal(r.payload.services.length,2);
  const linked=await one('select * from trips where id=$1',[next.id]);assert.equal(linked.truck_id,main.id);assert.equal(linked.status,'Asignado');assert.equal(linked.resource_version,1);
  await assert.rejects(query("update trips set status='En carga' where id=$1",[first.id]),e=>e.code==='P7503');
  await query('update trips set revenue_clp=123 where id=$1',[first.id]);
  assert.equal(Number((await one('select revenue_clp from trips where id=$1',[first.id])).revenue_clp),123);
  assert.equal((await one('select count(*)::int n from trip_resource_revisions where trip_id=$1',[next.id])).n,2);
  await query("update trips set status='En tránsito',actual_departure=now() where id=$1",[next.id]);
  r=await run('patch',resource,next.id,{...desired(replacement,1),reason:'Reemplazo en ruta por falla P1'});assert.equal(r.statusCode,200,JSON.stringify(r.payload));
  const current=await one('select * from operational_outings where id=$1',[outingId]);assert.equal(current.truck_id,replacement.id);assert.equal(current.version,3);assert.equal(current.closed_at,null);
  assert.equal((await one("select reason from operational_outing_events where outing_id=$1 and kind='resource_change'",[outingId])).reason,'Reemplazo en ruta por falla P1');
  assert.equal((await one("select count(*)::int n from audit_logs where entity='operational_outing' and action='resource_change' and entity_id=$1",[String(outingId)])).n,1);
  await assertTripAvailability(pool,{companyId:cid,truckId:main.id,plannedDeparture:'2090-01-01',plannedArrival:'2090-01-02'});
  await assert.rejects(assertTripAvailability(pool,{companyId:cid,truckId:replacement.id,plannedDeparture:'2090-01-01',plannedArrival:'2090-01-02'}),e=>e.code==='TRIP_RESOURCE_CONFLICT');
  assert.equal((await one('select truck_id from trips where id=$1',[first.id])).truck_id,main.id);
  await assert.rejects(query('update trips set truck_id=$1,resource_version=resource_version+1 where id=$2',[replacement.id,first.id]));
 }finally{await pg.close();}
});
