'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {MIGRATION_FILES}=require('../startup'),{registerCommercialRoutes}=require('../commercial-api'),{commercialGate}=require('../commercial-gate');
const source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
test('PL35/PL38 PostgreSQL aislado: prepago, cupos identificados, módulos y solicitudes',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),pg=new PGlite();
 const query=async(sql,v=[])=>{const r=await pg.query(sql,v);return {...r,rowCount:r.rows.length||r.affectedRows||0};},one=async(sql,v)=>(await query(sql,v)).rows[0],pool={query,connect:async()=>({query,release(){}})};
 let serial=0;
 try{
  await pg.exec(source('schema.sql'));await pg.exec(source('migrations/002_core_platform.sql'));for(const name of MIGRATION_FILES)await pg.exec(source('migrations/'+name));
  const app={},routes=[];for(const m of ['get','post','patch','put','delete'])app[m]=(p,...h)=>routes.push({m,p,h});registerCommercialRoutes(app,pool);require('../admin-api').registerAdminRoutes(app,pool);require('../core-api').registerCoreRoutes(app,pool);
  const role=await one("select id from roles where code='company_admin'"),platformUser=await one("insert into users(name,email) values('Plataforma fixture','platform-commercial@example.invalid') returning id");
  const platform={id:platformUser.id,name:'Plataforma fixture',actor_type:'platform',scope:'platform',platform_membership_id:1,permissions:['platform.companies.manage']};
  const res=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;},sendStatus(n){this.statusCode=n;return this;}});
  async function run(actor,method,p,body={},params={}){const r=routes.find(r=>r.m===method&&r.p===p);assert.ok(r,p);const request={user:actor,body,params,query:{},path:p.replace(/:([A-Za-z]+)/g,(_,k)=>params[k]),ip:'127.0.0.1'},response=res();const next=async i=>{let pending;await r.h[i](request,response,()=>{pending=next(i+1);return pending;});if(pending)await pending;};await next(0);return response;}
  async function fixture(n=5){
   const c=await one('insert into companies(legal_name) values($1) returning *',['Comercial fixture '+ ++serial]);
   const u=await one('insert into users(company_id,role_id,name,email) values($1,$2,$3,$4) returning id',[c.id,role.id,'Admin fixture','commercial-'+serial+'@example.invalid']);
   const client=await one("insert into clients(company_id,name) values($1,'Cliente fixture') returning id",[c.id]);
   const units=[];for(let i=0;i<n;i++)units.push(await one("insert into trucks(company_id,patente,tipo,brand,model) values($1,$2,'Camión','Marca fixture','Modelo fixture') returning *",[c.id,'COM-'+ ++serial]));
   return {cid:Number(c.id),client,units,actor:{id:u.id,name:'Admin fixture',actor_type:'company',scope:'company',company_id:Number(c.id),membership_id:1,permissions:['company.users.manage','trips.manage','fleet.manage','maintenance.manage']}};
  }
  const BASE='/api/platform/commercial/companies/:companyId',own='/api/company/commercial';
  const call=(f,method,suffix,body={},params={})=>run(platform,method,BASE+suffix,body,{companyId:f.cid,...params});
  async function plan(max=5,included=['operations','maintenance','gps','pod','fuel']){const r=await run(platform,'post','/api/platform/commercial/plans',{code:'fixture-'+ ++serial,name:'Plan fixture',max_equipment:max,allowed_modules:require('../commercial-domain').MODULES,included_modules:included});assert.equal(r.statusCode,201,JSON.stringify(r.payload));return r.payload;}
  const timing=()=>({period_from:new Date(Date.now()-60000).toISOString(),period_until:new Date(Date.now()+30*86400000).toISOString(),valid_until:new Date(Date.now()+86400000).toISOString()});
  async function proposal(f,p,extra={}){const c=await one('select commercial_version from companies where id=$1',[f.cid]);return call(f,'post','/quotes',{client_key:'quote-'+ ++serial,version:c.commercial_version,kind:'initial',plan_id:Number(p.id),quantities:{truck:3},unit_prices:{truck:1000},modules:[],module_prices:{},...timing(),reason:'Acuerdo comercial fixture',...extra});}
  async function pay(f,q,{units=[],...extra}={}){
   let r=await run(f.actor,'post',own+'/quotes/:id/accept',{reason:'Acepto condiciones fixture'},{id:q.id});assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   return call(f,'post','/quotes/:id/payment',{payment_reference:'paid-fixture-'+ ++serial,amount_clp:Number(q.amount_clp),payment_confirmed:true,reason:'Pago recibido fixture',equipment_ids:units.map(u=>Number(u.id)),...extra},{id:q.id});
  }
  async function setup({max=5,count=3,enabled=3,included}={}){const f=await fixture(),p=await plan(max,included),r=await proposal(f,p,{quantities:{truck:count}});assert.equal(r.statusCode,200,JSON.stringify(r.payload));const paid=await pay(f,r.payload,{units:f.units.slice(0,enabled)});assert.equal(paid.statusCode,200,JSON.stringify(paid.payload));return {...f,p,quote:r.payload,contract:paid.payload};}
  const seat=async(f,u,extra={})=>{const c=await one('select commercial_version from companies where id=$1',[f.cid]),s=await one('select version from commercial_equipment_seats where truck_id=$1',[u.id]);return call(f,'post','/equipment',{version:c.commercial_version,truck_id:Number(u.id),seat_version:s?.version||0,active:true,reason:'Habilitación fixture',...extra});};
  const trip=async(f,u,status='Planificado')=>one('insert into trips(company_id,trip_number,client_id,truck_id,origin,destination,status) values($1,$2,$3,$4,$5,$6,$7) returning *',[f.cid,'COM-TRIP-'+ ++serial,f.client.id,u?.id||null,'Origen fixture','Destino fixture',status]);

  await t.test('migración idempotente no inventa pagos, cupos ni bloquea clientes anteriores',async()=>{const f=await fixture();await pg.exec(source('migrations/038_commercial_entitlements.sql'));assert.equal((await one('select commercial_enforced from companies where id=$1',[f.cid])).commercial_enforced,false);assert.equal((await one('select count(*)::int n from commercial_contracts where company_id=$1',[f.cid])).n,0);assert.ok(await trip(f,f.units[0]));});
  await t.test('plan 5, contrato 3: registra 5, opera 3, no habilita los restantes',async()=>{
   const f=await setup(),s=await call(f,'get','');assert.equal(s.payload.active.configuration.max_equipment,5);assert.equal(s.payload.active.configuration.quantities.truck,3);assert.equal(s.payload.equipment.length,5);assert.equal(s.payload.equipment.filter(e=>e.enabled).length,3);
   assert.ok(await trip(f,f.units[0]));assert.equal((await seat(f,f.units[3])).statusCode,409);await assert.rejects(trip(f,f.units[3]),e=>e.code==='P7503');
   let next=false,response=res();await commercialGate(pool)({user:f.actor,method:'POST',originalUrl:'/api/fleet/work-orders',body:{truck_id:Number(f.units[3].id)},query:{}},response,()=>{next=true;});assert.equal(next,false);assert.equal(response.statusCode,409);assert.equal(response.payload.code,'COMMERCIAL_BLOCKED');
   assert.equal((await one('select count(*)::int n from commercial_equipment_seats where company_id=$1 and active',[f.cid])).n,3);
  });
  await t.test('aceptación sin pago, importe incorrecto y confirmación ausente no habilitan',async()=>{
   const f=await fixture(),p=await plan(),q=(await proposal(f,p)).payload;
   await assert.rejects(query('insert into commercial_contracts(company_id,quote_id,version,configuration,period_from,period_until) values($1,$2,1,$3,$4,$5)',[f.cid,q.id,q.configuration,q.period_from,q.period_until]),e=>e.code==='P7501');
   let r=await call(f,'post','/quotes/:id/payment',{payment_reference:'unaccepted',amount_clp:3000,payment_confirmed:true,reason:'Fixture'},{id:q.id});assert.equal(r.statusCode,409);
   r=await pay(f,q,{amount_clp:2999});assert.equal(r.statusCode,400);r=await pay(f,q,{payment_confirmed:false});assert.equal(r.statusCode,400);
   assert.equal((await one('select count(*)::int n from commercial_contracts where company_id=$1',[f.cid])).n,0);assert.equal((await seat(f,f.units[0])).statusCode,409);
  });
  await t.test('ampliación pagada permite cuarto cupo, nunca excede techo y conserva idempotencia de pago',async()=>{
   const f=await setup(),q=await proposal(f,f.p,{kind:'expansion',target_contract_id:Number(f.contract.id),quantities:{truck:4},period_from:new Date(f.contract.period_from).toISOString(),period_until:new Date(f.contract.period_until).toISOString()});assert.equal(q.statusCode,200,JSON.stringify(q.payload));assert.ok(Number(q.payload.amount_clp)>900&&Number(q.payload.amount_clp)<=1000);
   assert.equal((await seat(f,f.units[3])).statusCode,409);const ref='expansion-'+ ++serial;
   let r=await pay(f,q.payload,{units:[f.units[3]],payment_reference:ref});assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   r=await call(f,'post','/quotes/:id/payment',{payment_reference:ref,amount_clp:Number(q.payload.amount_clp),reason:'Reintento'},{id:q.payload.id});assert.equal(r.statusCode,200);assert.ok(await trip(f,f.units[3]));
   assert.equal((await seat(f,f.units[4])).statusCode,409);assert.equal((await proposal(f,f.p,{kind:'expansion',target_contract_id:Number(r.payload.id),quantities:{truck:6},period_from:new Date(f.contract.period_from).toISOString(),period_until:new Date(f.contract.period_until).toISOString()})).statusCode,400);
   assert.equal((await one('select count(*)::int n from commercial_contracts where company_id=$1',[f.cid])).n,2);
  });
  await t.test('sustitución es atómica, misma categoría, no libera cupos en viajes o mantención',async()=>{
   const f=await setup(),old=f.units[0];let r=await seat(f,f.units[3],{replace_truck_id:Number(old.id),replace_seat_version:1});assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal((await one('select active from commercial_equipment_seats where truck_id=$1',[old.id])).active,false);
   await trip(f,f.units[1]);r=await seat(f,f.units[4],{replace_truck_id:Number(f.units[1].id),replace_seat_version:1});assert.equal(r.statusCode,409);assert.equal((await one('select active from commercial_equipment_seats where truck_id=$1',[f.units[1].id])).active,true);
   await query("insert into maintenance(company_id,truck_id,item,status) values($1,$2,'Trabajo fixture','En proceso')",[f.cid,f.units[2].id]);r=await seat(f,f.units[4],{replace_truck_id:Number(f.units[2].id),replace_seat_version:1});assert.equal(r.statusCode,409);
   await assert.rejects(query("update trucks set patente='OTRA-PATENTE' where id=$1",[f.units[3].id]),e=>e.code==='P7503');
  });
  await t.test('empresa no puede confirmar pagos, habilitar unidades ni operar otra empresa',async()=>{
   const f=await setup(),other=await setup();assert.equal((await run(f.actor,'post',BASE+'/equipment',{},{companyId:f.cid})).statusCode,403);assert.equal((await run(f.actor,'get',BASE,{},{companyId:other.cid})).statusCode,403);
   const request={client_key:'request-id',quantities:{truck:4},modules:['gps'],reason:'Necesito otro camión',company_id:other.cid};let r=await run(f.actor,'post',own+'/requests',request);assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.equal(Number(r.payload.company_id),f.cid);
   assert.equal((await run(f.actor,'post',own+'/requests',request)).payload.id,r.payload.id);assert.equal((await run(f.actor,'post',own+'/requests',{...request,reason:'Otros datos'})).statusCode,409);
   assert.equal((await call(f,'post','/equipment',{version:1,truck_id:Number(other.units[0].id),seat_version:0,active:true,reason:'Ajeno'})).statusCode,404);
   assert.equal((await run(platform,'patch','/api/admin/companies/:id',{truck_limit:999},{id:f.cid})).statusCode,409);
  });
  await t.test('módulos son efectivos en SQL y API; mantenimiento y GPS no se autoactivan por rol',async()=>{
   const f=await setup({included:['operations']}),u=f.units[0];await assert.rejects(query("insert into maintenance(company_id,truck_id,item) values($1,$2,'Sin módulo')",[f.cid,u.id]),e=>e.code==='P7502');await assert.rejects(query('insert into telemetry(truck_id,lat,lng) values($1,0,0)',[u.id]),e=>e.code==='P7502');
   const running=await trip(f,u,'En tránsito');await assert.rejects(query("insert into trip_delivery_proofs(trip_id,recipient_name) values($1,'Sin POD')",[running.id]),e=>e.code==='P7502');
   let next=false,response=res();await commercialGate(pool)({user:f.actor,method:'POST',originalUrl:'/api/fleet/work-orders',body:{},query:{}},response,()=>{next=true;});assert.equal(next,false);assert.equal(response.statusCode,403);
   response=res();next=false;await commercialGate(pool)({user:f.actor,method:'GET',originalUrl:'/api/fleet/work-orders',query:{}},response,()=>{next=true;});assert.equal(next,true);
  });
  await t.test('renovación prepagada conserva la fecha y limita futuras habilitaciones',async()=>{
   const f=await setup(),until=new Date(f.contract.period_until),renewal=await proposal(f,f.p,{kind:'renewal',period_from:until.toISOString(),period_until:new Date(until.getTime()+30*86400000).toISOString()});assert.equal(renewal.statusCode,200,JSON.stringify(renewal.payload));assert.equal((await pay(f,renewal.payload)).statusCode,200);
   const expanded=await proposal(f,f.p,{kind:'expansion',target_contract_id:Number(f.contract.id),quantities:{truck:4},period_from:new Date(f.contract.period_from).toISOString(),period_until:until.toISOString()});assert.equal(expanded.statusCode,200,JSON.stringify(expanded.payload));assert.equal((await pay(f,expanded.payload)).statusCode,200);assert.equal((await seat(f,f.units[3])).statusCode,409);
   const future=(await one('select * from commercial_contracts where quote_id=$1',[renewal.payload.id])),futureExtra=await proposal(f,f.p,{kind:'expansion',target_contract_id:Number(future.id),quantities:{truck:4},period_from:new Date(future.period_from).toISOString(),period_until:new Date(future.period_until).toISOString()});assert.equal(futureExtra.statusCode,200,JSON.stringify(futureExtra.payload));assert.equal(Number(futureExtra.payload.amount_clp),1000);assert.equal((await pay(f,futureExtra.payload)).statusCode,200);assert.equal((await seat(f,f.units[3])).statusCode,200);
  });
  await t.test('fallo de auditoría revierte pago, habilitación y cambio de versión',async()=>{
   const f=await fixture(),p=await plan(),q=(await proposal(f,p)).payload;
   await pg.exec("create function fail_commercial_audit() returns trigger as $$ begin if NEW.entity='commercial_contract' then raise exception 'fixture audit failure'; end if; return NEW; end; $$ language plpgsql; create trigger fail_commercial_audit before insert on audit_logs for each row execute function fail_commercial_audit();");
   try{assert.equal((await pay(f,q,{units:f.units.slice(0,3)})).statusCode,500);}finally{await pg.exec('drop trigger fail_commercial_audit on audit_logs; drop function fail_commercial_audit();');}
   assert.equal((await one('select commercial_version from companies where id=$1',[f.cid])).commercial_version,0);assert.equal((await one('select count(*)::int n from commercial_equipment_seats where company_id=$1',[f.cid])).n,0);assert.equal((await one("select count(*)::int n from commercial_quote_events where quote_id=$1 and kind='paid'",[q.id])).n,0);
  });
  await t.test('contratos y decisiones son inmutables; cambios concurrentes obsoletos no sobrescriben',async()=>{
   const f=await setup();await assert.rejects(query("update commercial_contracts set configuration='{}' where id=$1",[f.contract.id]),/inmutables/);await assert.rejects(query('delete from commercial_quote_events where quote_id=$1',[f.quote.id]),/inmutables/);
   const q=await call(f,'post','/quotes',{version:0,client_key:'stale',kind:'renewal'});assert.equal(q.statusCode,409);assert.equal((await seat(f,f.units[0],{seat_version:0})).statusCode,409);
  });
  await t.test('empresas nuevas creadas por plataforma nacen controladas sin período pagado',async()=>{
   const r=await run(platform,'post','/api/companies',{legal_name:'Cliente nuevo fixture'});assert.equal(r.statusCode,201,JSON.stringify(r.payload));const c=await one('select commercial_enforced from companies where id=$1',[r.payload.id]);assert.equal(c.commercial_enforced,true);await assert.rejects(query("insert into trips(company_id,trip_number,origin,destination) values($1,$2,'Origen','Destino')",[r.payload.id,'NEW-'+ ++serial]),e=>e.code==='P7501');
  });
  await t.test('vencimiento bloquea nuevos servicios, pero preserva consulta y cierre controlado de los que estaban en ejecución',async()=>{
   // Historical fixture only: no clock change, production SQL or live paid data.
   const f=await fixture(),p=await plan(),running=await trip(f,f.units[0],'En tránsito'),planned=await trip(f,f.units[1]);
   const work=await one("insert into maintenance(company_id,truck_id,item,status) values($1,$2,'Ingreso anterior fixture','En proceso') returning id",[f.cid,f.units[2].id]);
   const from=new Date(Date.now()-60*86400000),until=new Date(Date.now()-30*86400000),configuration={plan_id:p.id,plan_code:p.code,plan_name:p.name,max_equipment:5,quantities:{truck:3,tractor:0,trailer:0,equipment:0},unit_prices:{truck:1000,tractor:null,trailer:null,equipment:null},modules:['operations','maintenance','pod'],module_prices:{operations:0,maintenance:0,pod:0},period_price_clp:3000};
   const q=await one("insert into commercial_quotes(company_id,client_key,payload_hash,base_version,kind,configuration,period_from,period_until,valid_until,amount_clp,reason,actor_user_id) values($1,$2,'fixture',0,'initial',$3,$4,$5,$5,3000,'Historia fixture',$6) returning id",[f.cid,'historical-'+ ++serial,configuration,from,until,platform.id]);
   await query("insert into commercial_quote_events(company_id,quote_id,kind,actor_user_id,reason,payment_reference,amount_clp) values($1,$2,'paid',$3,'Pago histórico fixture',$4,3000)",[f.cid,q.id,platform.id,'historical-payment-'+serial]);
   await query("insert into commercial_quote_events(company_id,quote_id,kind,actor_user_id,reason) values($1,$2,'accepted',$3,'Aceptación histórica fixture')",[f.cid,q.id,platform.id]);
   await query('insert into commercial_contracts(company_id,quote_id,version,configuration,period_from,period_until) values($1,$2,1,$3,$4,$5)',[f.cid,q.id,configuration,from,until]);await query('update companies set commercial_enforced=true,commercial_version=1 where id=$1',[f.cid]);
   await assert.rejects(trip(f,f.units[0]),e=>e.code==='P7501');await assert.rejects(query("update trips set status='En tránsito' where id=$1",[planned.id]),e=>e.code==='P7501');
   await query('insert into telemetry(truck_id,trip_id,lat,lng) values($1,$2,0,0)',[f.units[0].id,running.id]);await query('update trucks set lat=0,lng=0 where id=$1',[f.units[0].id]);
   await query("update trips set status='Detenido' where id=$1",[running.id]);await query("update trips set status='Completado' where id=$1",[running.id]);await query("update maintenance set status='Completada',released_at=now(),routine=$2 where id=$1",[work.id,{name:'Rutina fixture',days:30}]);
   await assert.rejects(query('insert into telemetry(truck_id,trip_id,lat,lng) values($1,$2,0,0)',[f.units[0].id,running.id]),e=>e.code==='P7501');
   const successor=await one("insert into maintenance(company_id,truck_id,item,maintenance_type,status,operation_stage,cost_clp,previous_work_order_id) values($1,$2,'Recordatorio fixture','Preventiva','Pendiente','scheduled',null,$3) returning id",[f.cid,f.units[2].id,work.id]);
   await assert.rejects(query("update maintenance set status='En proceso' where id=$1",[successor.id]),e=>e.code==='P7501');
   let allowed=false,r=res();await commercialGate(pool)({user:f.actor,method:'GET',originalUrl:'/api/operations/trips/'+running.id,query:{}},r,()=>{allowed=true;});assert.equal(allowed,true);
   r=res();await commercialGate(pool)({user:f.actor,method:'POST',originalUrl:'/api/trips',body:{},query:{}},r,()=>{throw Error('No debe permitir crear');});assert.equal(r.statusCode,403);
   assert.equal((await call(f,'get','')).payload.state,'expired');
  });
 }finally{await pg.close();}
});
