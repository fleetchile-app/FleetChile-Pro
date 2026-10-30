
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {MIGRATION_FILES}=require('../startup'),{registerEconomicsRoutes}=require('../economics-api'),{registerFinanceRoutes}=require('../finance-api');
const source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8'),BASE='/api/economics/trips/:id/finance',SOURCES='/api/economics/sources';
test('PL25–PL29 PostgreSQL aislado: fuentes, presupuestos, reparto, conciliación y cierre',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),pg=new PGlite();
 const query=async(sql,v=[])=>{const r=await pg.query(sql,v);return {...r,rowCount:r.rows.length||r.affectedRows||0};},one=async(sql,v)=>(await query(sql,v)).rows[0],pool={query,connect:async()=>({query,release(){}})};
 let serial=0;
 try{
  await pg.exec(source('schema.sql'));await pg.exec(source('migrations/002_core_platform.sql'));for(const m of MIGRATION_FILES)await pg.exec(source('migrations/'+m));
  const role=await one("select id from roles where code='company_admin'");
  const hash='scrypt$fixture$'+crypto.scryptSync('fixture-password','fixture',64,{N:16384,r:8,p:1}).toString('hex');
  const app={},routes=[];for(const m of ['get','post','patch','put','delete'])app[m]=(p,...h)=>routes.push({m,p,h});
  registerEconomicsRoutes(app,pool);registerFinanceRoutes(app,pool);
  async function run(f,m,p,body={},params={},filters={}){
   const matches=routes.filter(r=>r.m===m&&r.p===p);assert.ok(matches.length,p);const handlers=matches.flatMap(r=>r.h),req={user:f.actor,body,params,query:filters,ip:'127.0.0.1'};
   const res={statusCode:200,headers:{},status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;},set(k,v){this.headers[k]=v;return this;},type(v){this.headers.type=v;return this;},send(v){this.payload=v;return this;},sendStatus(n){this.statusCode=n;return this;}};
   const next=async i=>{if(!handlers[i])return;let pending;await handlers[i](req,res,()=>{pending=next(i+1);return pending;});if(pending)await pending;};await next(0);return res;
  }
  async function fixture(){
   const c=await one('insert into companies(legal_name) values($1) returning id',['Finanzas fixture '+ ++serial]);
   const u=await one('insert into users(company_id,role_id,name,email,password_hash) values($1,$2,$3,$4,$5) returning id',[c.id,role.id,'Autor fixture','fin-'+serial+'@example.invalid',hash]);
   const approver=await one('insert into users(company_id,role_id,name,email,password_hash) values($1,$2,$3,$4,$5) returning id',[c.id,role.id,'Autorizador fixture','approve-'+serial+'@example.invalid',hash]);
   const client=await one("insert into clients(company_id,name) values($1,'Cliente fixture') returning id",[c.id]);
   const truck=await one("insert into trucks(company_id,patente,tipo) values($1,$2,'Camión') returning id",[c.id,'FN'+serial]);
   const trip=await one("insert into trips(company_id,trip_number,client_id,truck_id,origin,destination,status,distance_km) values($1,$2,$3,$4,'Origen fixture','Destino fixture','Completado',100) returning *",[c.id,'FIN-'+serial,client.id,truck.id]);
   const actor={id:u.id,name:'Autor fixture',company_id:c.id,actor_type:'company',scope:'company',membership_id:1,permissions:['economics.read','economics.manage','economics.approve','economics.close','economics.export']};
   return {cid:c.id,trip,truck,client,actor,approver:{...actor,id:approver.id,name:'Autorizador fixture'}};
  }
  const state=async f=>{const r=await run(f,'get',BASE,{}, {id:f.trip.id});assert.equal(r.statusCode,200,JSON.stringify(r.payload));return r.payload;};
  async function revenue(f,n=10000){const r=await run(f,'patch','/api/economics/trips/:id/revenue',{revenue_clp:n,revenue_includes_vat:true,reason:'Ingreso fixture'},{id:f.trip.id});assert.equal(r.statusCode,200,JSON.stringify(r.payload));}
  async function cost(f,amount=2000,basis='observed',category='fuel'){
   const r=await run(f,'post','/api/economics/trips/:id/costs',{amount_clp:amount,amount_includes_vat:true,cost_basis:basis,category_code:category,support_status:'undocumented',justification:'Fixture sin documento real'},{id:f.trip.id});assert.equal(r.statusCode,201,JSON.stringify(r.payload));return r.payload;
  }
  async function approve(f,c){
   if(c.status==='reconciled'){assert.ok(c.reconciled_by);return;}
   let r=await run(f,'post','/api/economics/authorizations',{trip_id:Number(f.trip.id),request_type:'cost_version',cost_version_id:Number(c.version_id||c.id),reason:'Verificar costo fixture'});assert.equal(r.statusCode,201,JSON.stringify(r.payload));
   const request=r.payload;r=await run({...f,actor:f.approver},'post','/api/economics/authorizations/:id/approve',{reason:'Verificado fixture',password:'fixture-password'},{id:request.id});assert.equal(r.statusCode,200,JSON.stringify(r.payload));return request;
  }
  async function reconcile(f,itemId){const current=await one('select v.* from trip_cost_items i join trip_cost_versions v on v.id=i.current_version_id where i.id=$1',[itemId]);if(current.status==='reconciled')return current;const r=await run(f,'post','/api/economics/costs/:id/reconcile',{reason:'Conciliación fixture'},{id:itemId});assert.equal(r.statusCode,201,JSON.stringify(r.payload));return r.payload;}
  async function sourceRecord(f,amount=2000){const r=await run(f,'post',SOURCES,{kind:'toll',provider:'Proveedor fixture',reference:'REF-'+ ++serial,occurred_on:'2026-10-25',amount_clp:amount,includes_vat:true,description:'Comprobante fixture'});assert.equal(r.statusCode,201,JSON.stringify(r.payload));return r.payload;}

  await t.test('migración aditiva idempotente preserva importes y no inventa costos o repartos',async()=>{
   const f=await fixture();await pg.exec(source('migrations/036_economic_integration.sql'));const s=await state(f);assert.equal(s.control.state,'open');assert.equal(s.summary.revenue_clp,null);assert.equal(s.summary.recognized_costs_clp,null);assert.equal(s.distributions.length,0);
  });
  await t.test('ingreso, costo reconocido, delta, reporte, CSV y dashboard coinciden con SQL real',async()=>{
   const f=await fixture();await revenue(f);const c=await cost(f);await approve(f,c);await reconcile(f,c.item_id);
   const s=await state(f),d=await run(f,'get','/api/economics/trips/:id/delta',{}, {id:f.trip.id}),report=await run(f,'get','/api/economics/reports',{}, {},{report:'economic'}),k=await run(f,'get','/api/economics/kpis');
   for(const r of [d,report,k])assert.equal(r.statusCode,200,JSON.stringify(r.payload));
   assert.equal(s.summary.delta_clp,8000);assert.equal(d.payload.delta,8000);assert.equal(report.payload.rows[0].delta,8000);assert.equal(k.payload.economics.delta.reconciled,8000);
   const csv=await run(f,'get','/api/economics/reports',{}, {},{report:'economic',format:'csv'});assert.match(csv.payload,/8000/);
   const draft=await cost(f,0,'observed','other_direct');const reports=await run(f,'get','/api/economics/reports',{}, {},{report:'economic'}),kp=await run(f,'get','/api/economics/kpis');assert.equal(reports.payload.rows[0].delta_status,'provisional');assert.equal(kp.payload.economics.delta.provisional,8000);
  });
  await t.test('presupuesto se versiona aparte; valores no comparables no generan variación inventada',async()=>{
   const f=await fixture();await revenue(f);const c=await cost(f);await approve(f,c);await reconcile(f,c.item_id);let s=await state(f);
   let r=await run(f,'post',BASE+'/budget',{version:Number(s.control.version),reason:'Presupuesto fixture',entries:[{category_code:'fuel',amount_clp:1500,includes_vat:true}]},{id:f.trip.id});assert.equal(r.statusCode,201,JSON.stringify(r.payload));
   s=await state(f);assert.equal(s.comparison[0].variance_clp,500);assert.equal(s.summary.recognized_costs_clp,2000);
   r=await run(f,'post',BASE+'/budget',{version:Number(s.control.version),reason:'Otra base',entries:[{category_code:'fuel',amount_clp:1500,includes_vat:null}]},{id:f.trip.id});assert.equal(r.statusCode,201);
   s=await state(f);assert.equal(s.comparison[0].variance_clp,null);assert.equal(s.budgets.length,2);
   await assert.rejects(query('delete from trip_budget_revisions where trip_id=$1',[f.trip.id]),/inmutables/);
  });
  await t.test('fuente se reparte sin exceder saldo ni duplicar un costo existente',async()=>{
   const f=await fixture(),source=await sourceRecord(f,3000),existing=await cost(f,2000,'observed','toll');let s=await state(f);
   let r=await run(f,'post',SOURCES+'/:sourceId/allocate',{trip_id:Number(f.trip.id),version:Number(s.control.version),source_version:0,amount_clp:2000,cost_item_id:Number(existing.item_id),reason:'Vincular, no duplicar'},{sourceId:source.id});assert.equal(r.statusCode,201,JSON.stringify(r.payload));
   assert.equal((await one('select count(*)::int n from trip_cost_items where trip_id=$1',[f.trip.id])).n,1);
   s=await state(f);r=await run(f,'post',SOURCES+'/:sourceId/allocate',{trip_id:Number(f.trip.id),version:Number(s.control.version),source_version:1,amount_clp:2000,reason:'Exceder saldo'},{sourceId:source.id});assert.equal(r.statusCode,409,JSON.stringify(r.payload));
   assert.equal((await one('select count(*)::int n from trip_cost_items where trip_id=$1',[f.trip.id])).n,1);
   const other=await fixture();r=await run(other,'post',SOURCES+'/:sourceId/allocate',{trip_id:Number(other.trip.id),version:0,source_version:1,amount_clp:500,reason:'Ajeno'},{sourceId:source.id});assert.equal(r.statusCode,404);
  });
  await t.test('combustible se enlaza por ID real; duplicado y modificación silenciosa del origen son rechazados',async()=>{
   const f=await fixture(),fuel=await one('insert into fuel(company_id,truck_id,total_clp,liters,date) values($1,$2,4000,5,$3) returning *',[f.cid,f.truck.id,'2026-10-25']);
   const body={kind:'fuel',fuel_id:Number(fuel.id),includes_vat:true,description:'Registro combustible fixture'};
   let r=await run(f,'post',SOURCES,body);assert.equal(r.statusCode,201,JSON.stringify(r.payload));assert.equal(Number(r.payload.amount_clp),4000);
   r=await run(f,'post',SOURCES,body);assert.equal(r.statusCode,409);
   await assert.rejects(query('update fuel set total_clp=5000 where id=$1',[fuel.id]),/origen económico/);
  });
  await t.test('reparto por carga conserva totales y cliente, detecta bases desactualizadas y no mueve dinero al transferir',async()=>{
   const f=await fixture();await revenue(f);const c=await cost(f);await approve(f,c);await reconcile(f,c.item_id);
   const l1=await one("insert into trip_loads(trip_id,client_id,cargo) values($1,$2,'Madera fixture') returning id",[f.trip.id,f.client.id]),l2=await one("insert into trip_loads(trip_id,client_id,cargo) values($1,$2,'Otra carga fixture') returning id",[f.trip.id,f.client.id]);
   let s=await state(f);const entries=[{load_id:Number(l1.id),client_id:999,revenue_clp:7000,cost_clp:1500},{load_id:Number(l2.id),revenue_clp:3000,cost_clp:500}];
   let r=await run(f,'post',BASE+'/distribution',{version:Number(s.control.version),basis_hash:s.basis_hash,entries,reason:'Reparto manual pactado'},{id:f.trip.id});assert.equal(r.statusCode,201,JSON.stringify(r.payload));assert.equal(r.payload.entries[0].client_id,Number(f.client.id));
   const csv=await run(f,'get',BASE+'/export',{}, {id:f.trip.id});assert.match(csv.payload,/7000/);
   await query('update trip_loads set client_id=null where id=$1',[l2.id]);s=await state(f);assert.equal(s.distribution_stale,true);
   assert.equal(Number((await one('select revenue_clp from trips where id=$1',[f.trip.id])).revenue_clp),10000);
  });
  await t.test('cierre exige permiso, reautenticación, TAG resuelto y conciliación; congela caminos antiguos y reabre con historia',async()=>{
   const f=await fixture();await revenue(f);const c=await cost(f);await approve(f,c);await reconcile(f,c.item_id);let s=await state(f);
   let r=await run(f,'post',BASE+'/pending-tolls',{version:Number(s.control.version),pending:true,reason:'Esperando detalle TAG'},{id:f.trip.id});assert.equal(r.statusCode,200);
   s=await state(f);r=await run(f,'post',BASE+'/close',{version:Number(s.control.version),reason:'Cerrar',password:'incorrecta'},{id:f.trip.id});assert.equal(r.statusCode,401);
   r=await run(f,'post',BASE+'/close',{version:Number(s.control.version),reason:'Cerrar',password:'fixture-password'},{id:f.trip.id});assert.equal(r.statusCode,409);
   await run(f,'post',BASE+'/pending-tolls',{version:Number(s.control.version),pending:false,reason:'Detalle confirmado'},{id:f.trip.id});s=await state(f);
   r=await run(f,'post',BASE+'/close',{version:Number(s.control.version),reason:'Cierre fixture',password:'fixture-password'},{id:f.trip.id});assert.equal(r.statusCode,200,JSON.stringify(r.payload));s=await state(f);assert.equal(s.control.state,'closed');assert.equal(s.events[0].snapshot.summary.delta_clp,8000);
   r=await run(f,'post','/api/economics/trips/:id/costs',{amount_clp:1,cost_basis:'observed',category_code:'fuel'},{id:f.trip.id});assert.equal(r.statusCode,409,JSON.stringify(r.payload));
   await assert.rejects(query('update trips set revenue_clp=9999 where id=$1',[f.trip.id]),/ECONOMIC_CLOSED/);
   r=await run(f,'post',BASE+'/reopen',{version:Number(s.control.version),reason:'Factura tardía fixture',password:'fixture-password'},{id:f.trip.id});assert.equal(r.statusCode,200,JSON.stringify(r.payload));s=await state(f);assert.equal(s.events.length,2);assert.equal(s.control.state,'open');
  });
  for(const leader of ['company_admin','manager'])await t.test(leader+' confirma su ingreso con contraseña, sin superior ni cuenta artificial; otros roles y costos mantienen separación',async()=>{
   const f=await fixture(),other=await fixture();
   const leaderRole=await one('select id from roles where code=$1',[leader]);const membership=await one('insert into user_memberships(company_id,user_id,role_id) values($1,$2,$3) returning id',[f.cid,f.actor.id,leaderRole.id]);
   f.actor={...f.actor,role_code:leader,membership_id:membership.id};
   await query('update trips set actual_departure=now(),revenue_clp=null where id=$1',[f.trip.id]);
   const requested=await run(f,'patch','/api/economics/trips/:id/revenue',{revenue_clp:250000,revenue_includes_vat:true,reason:'Confirmación inicial del servicio'},{id:f.trip.id});assert.equal(requested.statusCode,202,JSON.stringify(requested.payload));
   const id=requested.payload.request.id,path='/api/economics/authorizations/:id/approve',body={reason:'Resolución propia del administrador',password:'fixture-password'};
   assert.equal((await run(f,'post',path,{...body,password:'incorrecta'},{id})).statusCode,401);
   assert.equal((await run(f,'post',path,{...body,reason:''},{id})).statusCode,400);
   for(const code of ['operations','administrative'])assert.equal((await run({...f,actor:{...f.actor,role_code:code}},'post',path,body,{id})).statusCode,403);
   assert.equal((await run({...f,actor:{...f.actor,permissions:['economics.read']}},'post',path,body,{id})).statusCode,403);
   assert.equal((await run(other,'post',path,body,{id})).statusCode,404);
   assert.equal((await state(f)).revenue_self_resolution_allowed,true);
   const approved=await run(f,'post',path,body,{id});assert.equal(approved.statusCode,200,JSON.stringify(approved.payload));assert.equal(approved.payload.self_resolution,true);
   assert.equal(approved.payload.resolution_policy,leader==='manager'?'company_manager_revenue_exception':'company_admin_revenue_exception');
   const persisted=await one('select * from economic_authorization_requests where id=$1',[id]);assert.equal(String(persisted.resolved_by),String(persisted.requested_by));assert.equal(persisted.self_resolution,true);assert.ok(persisted.reauthenticated_at);
   assert.equal(Number((await one('select revenue_clp from trips where id=$1',[f.trip.id])).revenue_clp),250000);
   const audit=await one("select after_data from audit_logs where entity='economic_authorization' and entity_id=$1 and action='approved' order by id desc limit 1",[String(id)]);assert.equal(audit.after_data.resolution_policy,leader==='manager'?'company_manager_revenue_exception':'company_admin_revenue_exception');assert.doesNotMatch(JSON.stringify(audit),/fixture-password|password_hash/);
   assert.equal((await run(f,'post',path,body,{id})).statusCode,409);
   const expense=await cost(f,1000,'observed','other_direct'),request=await run(f,'post','/api/economics/authorizations',{trip_id:Number(f.trip.id),request_type:'cost_version',cost_version_id:Number(expense.current_version_id),reason:'Costo requiere independencia'});assert.equal(request.statusCode,201);
   assert.equal((await run(f,'post',path,body,{id:request.payload.id})).statusCode,403);
   await assert.rejects(query("update economic_authorization_requests set self_resolution=true,status='approved',resolved_by=requested_by,resolved_at=now(),reauthenticated_at=now(),resolution_reason='No autorizado' where id=$1",[request.payload.id]));
   await run({...f,actor:f.approver},'post',path,body,{id:request.payload.id});
   await reconcile(f,expense.item_id);
   const s=await state(f);assert.equal(s.summary.revenue_clp,250000);
   const closed=await run(f,'post',BASE+'/close',{version:Number(s.control.version),reason:'Cierre con ingreso confirmado por administrador',password:'fixture-password'},{id:f.trip.id});assert.equal(closed.statusCode,200,JSON.stringify(closed.payload));
  });
  await t.test('excepción de ingreso valida membresía en SQL y revierte aprobación propia si falla auditoría o cambió el monto',async()=>{
   const f=await fixture(),m=await one('insert into user_memberships(company_id,user_id,role_id) values($1,$2,$3) returning id',[f.cid,f.actor.id,role.id]);f.actor={...f.actor,role_code:'company_admin',membership_id:m.id};
   await query('update trips set actual_departure=now(),revenue_clp=15000 where id=$1',[f.trip.id]);
   const requested=await run(f,'patch','/api/economics/trips/:id/revenue',{revenue_clp:25000,revenue_includes_vat:null,reason:'Ajustar valor pactado'},{id:f.trip.id});assert.equal(requested.statusCode,202);
   const id=requested.payload.request.id,body={reason:'Confirmado por administrador',password:'fixture-password'};
   const ops=await one("select id from roles where code='operations'");await query('update user_memberships set role_id=$1 where id=$2',[ops.id,m.id]);
   await assert.rejects(query("update economic_authorization_requests set self_resolution=true,status='approved',resolved_by=requested_by,resolved_at=now(),reauthenticated_at=now(),resolution_reason='No autorizado' where id=$1",[id]),/administrador empresarial activo/);
   await query('update user_memberships set role_id=$1 where id=$2',[role.id,m.id]);
   await pg.exec("create function fail_own_revenue_audit() returns trigger as $own_audit$ begin if NEW.entity='economic_authorization' and NEW.action='approved' then raise exception 'audit fixture'; end if; return NEW; end; $own_audit$ language plpgsql; create trigger own_revenue_fail_audit before insert on audit_logs for each row execute function fail_own_revenue_audit();");
   try{const result=await run(f,'post','/api/economics/authorizations/:id/approve',body,{id});assert.equal(result.statusCode,500);}finally{await pg.exec('drop trigger own_revenue_fail_audit on audit_logs; drop function fail_own_revenue_audit();');}
   assert.equal(Number((await one('select revenue_clp from trips where id=$1',[f.trip.id])).revenue_clp),15000);
   const pending=await one('select status,self_resolution from economic_authorization_requests where id=$1',[id]);assert.equal(pending.status,'pending');assert.equal(pending.self_resolution,false);assert.equal(Number((await one('select count(*) n from trip_revenue_history where trip_id=$1',[f.trip.id])).n),0);
   await query('update trips set revenue_clp=16000 where id=$1',[f.trip.id]);assert.equal((await run(f,'post','/api/economics/authorizations/:id/approve',body,{id})).statusCode,409);
   await pg.exec(source('migrations/048_company_admin_revenue_resolution.sql'));
  });
  await t.test('fallo de auditoría revierte presupuesto y token; API directa no cruza empresas',async()=>{
   const f=await fixture(),other=await fixture();let r=await run(other,'get',BASE,{}, {id:f.trip.id});assert.equal(r.statusCode,404);
   await pg.exec("create function fail_fin_audit() returns trigger as $$ begin if NEW.entity='trip_budget' then raise exception 'fixture audit failure'; end if; return NEW; end; $$ language plpgsql; create trigger fin_fail_audit before insert on audit_logs for each row execute function fail_fin_audit();");
   try{r=await run(f,'post',BASE+'/budget',{version:0,reason:'Prueba rollback',entries:[{category_code:'fuel',amount_clp:1000,includes_vat:null}]},{id:f.trip.id});assert.equal(r.statusCode,500);}finally{await pg.exec('drop trigger fin_fail_audit on audit_logs; drop function fail_fin_audit();');}
   const s=await state(f);assert.equal(Number(s.control.version),0);assert.equal(s.budgets.length,0);
  });
 }finally{await pg.close();}
});
