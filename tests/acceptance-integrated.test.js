'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {embedded,harness}=require('./helpers/acceptance');
test('aceptación integrada: sesiones, prepago, tres entregas, incidentes, taller y cierre económico',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const runtime=await embedded();try{
  const {pool}=runtime,h=await harness(pool),a=await h.company('Aceptación A'),b=await h.company('Aceptación B'),platform=await h.account(null,'platform_superadmin','Plataforma sintética');let vehicle,person,driver,trip,ctx,loads=[],clients=[],order;
  const call=(token,method,url,body={},params={},query={})=>h.run(token,method,url,{body,params,query});
  const ok=async(token,method,url,body={},params={},expected=200)=>{const r=await call(token,method,url,body,params);assert.equal(r.statusCode,expected,method+' '+url+': '+JSON.stringify(r.payload));return r.payload;};
  const admin=(method,url,body={},params={},expected=200)=>ok(a.admin.token,method,url,body,params,expected);
  const MW='/api/fleet/work-orders',MOBILE='/api/driver/trips/:id/workflow',FIN='/api/economics/trips/:id/finance',COMM='/api/platform/commercial/companies/:companyId';
  await t.test('sesión real exige contrato, aísla empresas y crea clientes sin exigir consentimiento',async()=>{
   const denied=await call('', 'get','/api/company/clients');assert.equal(denied.statusCode,401);
   for(const [i,rut] of ['33333333-3','44444444-4','55555555-5'].entries())clients.push(await admin('post','/api/company/clients',{name:'Cliente sintético '+i,rut}, {},201));
   const foreign=await call(b.admin.token,'get','/api/company/clients/:id',{}, {id:clients[0].id});assert.equal(foreign.statusCode,404);
   const viewer=await h.account(a.id,'viewer','Consulta sintética','66666666-6');assert.equal((await call(viewer.token,'post','/api/company/clients',{name:'No permitido',rut:'77777777-7'})).statusCode,403);
   assert.equal((await admin('get','/api/company/clients')).total,3);
  });
  await t.test('persona conductora con contrato/licencia se registra una sola vez; vehículo admite documentación diferida',async()=>{
   const role=await h.one("select id from roles where code='driver'");person=(await admin('post','/api/company/people',{name:'Conductor sintético',rut:'12345678-5',birth_date:'1990-01-01',create_account:true,email:'driver@acceptance.invalid',password:h.password,role_id:Number(role.id),contract:{type:'indefinite',start_date:'2000-01-01'},license:{classes:['A5'],printed_expiry:'2099-12-31'}},{},201)).person;
   const candidates=await admin('get','/api/fleet/drivers/candidates');assert.ok(candidates.rows.some(r=>String(r.user_id)===String(person.user_id)&&r.eligible));
   await admin('post','/api/fleet/drivers',{user_id:Number(person.user_id)},{},201);assert.equal((await admin('get','/api/fleet/drivers/candidates')).rows.length,0);
   driver={id:Number(person.driver_id),token:await h.session(person.user_id)};
   vehicle=await admin('post','/api/fleet/vehicles',{patente:'SYNTH01',tipo:'Camión',brand:'Marca sintética',model:'Modelo sintético',capacity_t:10},{},201);assert.equal(vehicle.ready,false);
   const r=await admin('post','/api/trips',{client_id:Number(clients[0].id),origin:'Origen sintético',destination:'Destino sintético'},{},201);trip=r;
   const blocked=await call(a.admin.token,'patch','/api/operations/trips/:id/resources',{resource_version:0,composition_id:null,truck_id:Number(vehicle.id),driver_id:driver.id,client_id:Number(clients[0].id)},{id:trip.id});assert.equal(blocked.statusCode,409);
   vehicle=await admin('patch','/api/fleet/vehicles/:id',{profile_version:vehicle.profile_version,circulation_expiry:'2099-12-31',soap_expiry:'2099-12-31',inspection_expiry:'2099-12-31',reason:'Documentación sintética verificada'},{id:vehicle.id});
  });
  await t.test('prepago habilita solo un equipo identificado; ni empresa ni cupo del plan otorgan más unidades',async()=>{
   const modules=require('../commercial-domain').MODULES;
   const plan=await ok(platform.token,'post','/api/platform/commercial/plans',{code:'synthetic-acceptance',name:'Plan de prueba',max_equipment:5,allowed_modules:modules,included_modules:modules},{},201);
   const quote=await ok(platform.token,'post',COMM+'/quotes',{client_key:'acceptance-quote',version:0,kind:'initial',plan_id:Number(plan.id),quantities:{truck:1},unit_prices:{truck:1000},modules:[],module_prices:{},period_from:new Date(Date.now()-60000).toISOString(),period_until:new Date(Date.now()+86400000*30).toISOString(),valid_until:new Date(Date.now()+86400000).toISOString(),reason:'Acuerdo comercial sintético'},{companyId:a.id});
   await admin('post','/api/company/commercial/quotes/:id/accept',{reason:'Aceptación sintética'},{id:quote.id});
   await ok(platform.token,'post',COMM+'/quotes/:id/payment',{payment_reference:'synthetic-payment',amount_clp:Number(quote.amount_clp),payment_confirmed:true,equipment_ids:[Number(vehicle.id)],reason:'Pago sintético, no real'},{companyId:a.id,id:quote.id});
   const state=await admin('get','/api/company/commercial');assert.ok(state);
   const extra=await admin('post','/api/fleet/vehicles',{patente:'SYNTH02',tipo:'Camión',brand:'Marca',model:'Modelo'},{},201);
   const rejected=await call(a.admin.token,'post','/api/trips',{client_id:Number(clients[0].id),truck_id:Number(extra.id),origin:'O',destination:'D'});assert.equal(rejected.statusCode,409);
   trip=(await admin('patch','/api/operations/trips/:id/resources',{resource_version:0,composition_id:null,truck_id:Number(vehicle.id),driver_id:driver.id,client_id:Number(clients[0].id)},{id:trip.id})).trip;
  });
  await t.test('licencia vencida y condición vigente bloquean la sesión; renovación y retorno conservan trazabilidad',async()=>{
   await admin('post','/api/company/people/:id/licenses',{classes:['A5'],printed_expiry:'2020-01-01'},{id:person.id});
   assert.equal((await call(driver.token,'get',MOBILE,{}, {id:trip.id})).statusCode,403);
   await admin('post','/api/company/people/:id/licenses',{classes:['A5'],printed_expiry:'2099-12-31'},{id:person.id});
   assert.equal((await call(driver.token,'get',MOBILE,{}, {id:trip.id})).statusCode,200);
   const today=require('../personnel-domain').companyDate(),condition=await admin('post','/api/company/people/:id/conditions',{type:'vacation',start_date:today,end_date:today,reason:'Vacaciones sintéticas'},{id:person.id});
   assert.equal((await call(driver.token,'get',MOBILE,{}, {id:trip.id})).statusCode,403);
   await admin('post','/api/company/people/:id/conditions/:conditionId/cancel',{reason:'Fin anticipado sintético'},{id:person.id,conditionId:condition.condition.id});
   await admin('post','/api/company/people/:id/conditions',{type:'permission',start_date:'2000-01-01',end_date:'2000-01-02',reason:'Permiso sintético vencido'},{id:person.id});
   assert.equal((await call(driver.token,'get',MOBILE,{}, {id:trip.id})).statusCode,200);
   const {reconcilePersonnelNotifications}=require('../personnel-monitor');await reconcilePersonnelNotifications(pool);const before=await h.one('select count(*)::int n from personnel_notifications where company_id=$1',[a.id]);await reconcilePersonnelNotifications(pool);assert.ok(before.n>0);assert.equal((await h.one('select count(*)::int n from personnel_notifications where company_id=$1',[a.id])).n,before.n);
   const actor=await h.one("select actor_user_id from person_events where person_id=$1 and action='license_renew' order by id desc limit 1",[person.id]);assert.equal(Number(actor.actor_user_id),a.admin.id);
  });
  await t.test('itinerario multicliente de 10 toneladas guarda capacidad por tramo y rechaza edición obsoleta',async()=>{
   for(const [i,weight] of [4000,3000,3000].entries())loads.push(await admin('post','/api/operations/trips/:id/loads',{client_id:Number(clients[i].id),cargo:'Madera sintética '+i,weight_kg:weight},{id:trip.id},201));
   const locations=[];for(let i=0;i<4;i++)locations.push(await h.one("insert into operational_locations(company_id,name,lat,lng,source,normalized_at) values($1,$2,$3,$4,'synthetic-test',now()) returning id",[a.id,'Punto sintético '+i,-36+i*.1,-73+i*.1]));
   const plan={load_locations_token:require('../itinerary-coherence').token(loads),load_locations_ack:true,endpoint_change_ack:true,version:0,resource_version:trip.resource_version,departure:new Date(Date.now()+3600000).toISOString(),contingency_minutes:10,reason:'Itinerario de aceptación sintético',vehicle_review:{acknowledged:true,notes:'Revisión sintética; no certificación real'},stops:locations.map((l,i)=>({key:'s'+i,location_id:Number(l.id),purpose:i?'delivery':'pickup',service_minutes:10,wait_minutes:5,rest_minutes:0})),loads:loads.map((l,i)=>({load_id:Number(l.id),pickup:'s0',delivery:'s'+(i+1)}))};
   const r=await admin('put','/api/operations/trips/:id/itinerary',plan,{id:trip.id});assert.deepEqual(r.plan.capacity.segments.map(s=>s.weight_kg),[10000,6000,3000]);
   assert.equal((await call(a.admin.token,'put','/api/operations/trips/:id/itinerary',plan,{id:trip.id})).statusCode,409);ctx={version:1,resource_version:trip.resource_version};
  });
  const mobile=(action,body,expected=201)=>ok(driver.token,'post',MOBILE+'/'+action,{...ctx,...body},{id:trip.id},expected);
  await t.test('aceptación/checklist, incidente, tres POD y reintentos no duplican ni completan otras cargas',async()=>{
   const acceptance={client_key:'acceptance-device',reported_at:new Date().toISOString()};await mobile('accept',acceptance);await mobile('accept',acceptance,200);
   await mobile('checklist',{client_key:'checklist-device',items:require('../driver-workflow-api').CHECKS.map(id=>({id,result:'ok'}))});
   await admin('patch','/api/operations/trips/:id/status',{status:'En carga'},{id:trip.id});
   let serial=0;const event=(kind,stop_key,extra={})=>mobile('events',{event_key:'synthetic-event-'+ ++serial,kind,stop_key,...extra});
   await event('arrive','s0');for(const l of loads)await event('pickup','s0',{load_id:Number(l.id)});await event('depart','s0');
   await admin('patch','/api/operations/trips/:id/status',{status:'En tránsito'},{id:trip.id});
   await admin('post','/api/operations/trips/:id/events',{event_type:'Incidente',notes:'Demora sintética: neumático, no evento real'},{id:trip.id},201);
   const signature='iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGklEQVQ4jWP4TyFgGDXg/2gY/B8Ng//DIgwAXXj8LuMlDaEAAAAASUVORK5CYII=';
   for(let i=0;i<3;i++){
    await event('arrive','s'+(i+1));const body={...ctx,load_id:Number(loads[i].id),client_submission_id:'pod-acceptance-'+i,recipient_name:'Receptor sintético',signature};
    body.photo=signature;
    if(i===0){
     const put=h.storage.put;h.storage.put=async args=>{if(args.key.includes('/photo/'))throw Error('synthetic photo storage failure');return put(args);};
     try{const failed=await call(driver.token,'post','/api/driver/trips/:id/deliveries',body,{id:trip.id});assert.equal(failed.statusCode,400);assert.equal(h.objects.size,0);assert.equal((await h.one('select count(*)::int n from trip_delivery_proofs where trip_id=$1',[trip.id])).n,0);}
     finally{h.storage.put=put;}
    }
    await ok(driver.token,'post','/api/driver/trips/:id/deliveries',body,{id:trip.id},201);await ok(driver.token,'post','/api/driver/trips/:id/deliveries',body,{id:trip.id},200);
    assert.equal((await h.one("select count(*)::int n from trip_loads where trip_id=$1 and status='Entregada'",[trip.id])).n,i+1);await event('depart','s'+(i+1));
   }
   await admin('patch','/api/operations/trips/:id/status',{status:'Completado'},{id:trip.id});assert.equal((await h.one('select count(*)::int n from trip_delivery_proofs where trip_id=$1',[trip.id])).n,3);assert.equal(h.objects.size,6);
   const foreign=await call(b.admin.token,'get','/api/operations/trips/:id',{}, {id:trip.id});assert.equal(foreign.statusCode,404);
  });
  await t.test('administración consulta firma/foto privadas verificadas; otra empresa no descarga ni conoce claves',async()=>{
   const POD='/api/operations/trips/:id/pod',data=await admin('get',POD,{}, {id:trip.id});
   assert.equal(data.proofs.length,3);assert.doesNotMatch(JSON.stringify(data),/storage_key|companies\//);
   for(const proof of data.proofs){
    assert.deepEqual(proof.files.map(f=>f.type).sort(),['photo','signature']);
    for(const file of proof.files){
     const params={id:trip.id,proofId:proof.id,fileId:file.id},path=POD+'/:proofId/files/:fileId';
     const r=await call(a.admin.token,'get',path,{},params);assert.equal(r.statusCode,200,JSON.stringify(r.payload));assert.ok(Buffer.isBuffer(r.payload));assert.match(r.headers['Cache-Control'],/no-store/);
     const stored=await h.one('select storage_key,sha256 from delivery_proof_files where id=$1',[file.id]);assert.deepEqual(r.payload,h.objects.get(stored.storage_key));assert.equal(require('node:crypto').createHash('sha256').update(r.payload).digest('hex'),stored.sha256);
     assert.equal((await call(b.admin.token,'get',path,{},params)).statusCode,404);
    }
   }
   const file=data.proofs[0].files[0],stored=await h.one('select storage_key from delivery_proof_files where id=$1',[file.id]),original=h.objects.get(stored.storage_key);
   h.objects.set(stored.storage_key,Buffer.alloc(original.length));
   assert.equal((await call(a.admin.token,'get',POD+'/:proofId/files/:fileId',{}, {id:trip.id,proofId:data.proofs[0].id,fileId:file.id})).statusCode,503);h.objects.set(stored.storage_key,original);
  });
  await t.test('equipo entra a taller después del viaje; liberación técnica no espera factura',async()=>{
   const now=Date.now();order=await admin('post',MW,{mode:'receive',truck_id:Number(vehicle.id),reason:'Revisión sintética después del viaje',maintenance_type:'Correctiva',received_at:new Date(now-60000).toISOString(),odometer_km:100},{},201);
   const pending=await admin('post','/api/trips',{client_id:Number(clients[0].id),origin:'Origen',destination:'Destino'},{},201);
   const blocked=await call(a.admin.token,'patch','/api/operations/trips/:id/resources',{resource_version:0,composition_id:null,truck_id:Number(vehicle.id),driver_id:driver.id,client_id:Number(clients[0].id)},{id:pending.id});assert.equal(blocked.statusCode,409);
   order=await admin('patch',MW+'/:id',{work_order_version:order.work_order_version,diagnosis:'Diagnóstico sintético',work_summary:'Revisión realizada'},{id:order.id});
   order=await admin('post',MW+'/:id/items',{work_order_version:order.work_order_version,kind:'part',description:'Filtro sintético',quantity:1,estimated_unit_cost_clp:1000,status:'done'},{id:order.id});
   order=await admin('post',MW+'/:id/release',{work_order_version:order.work_order_version,released_at:new Date().toISOString(),odometer_km:101,release_note:'Verificación técnica sintética'},{id:order.id});assert.equal(order.operation_stage,'released');assert.equal(order.cost_clp,null);
   const line=order.lines[0];order=await admin('patch',MW+'/:id/items/:itemId',{work_order_version:order.work_order_version,actual_unit_cost_clp:1200},{id:order.id,itemId:line.id});order=await admin('post',MW+'/:id/close',{work_order_version:order.work_order_version},{id:order.id});assert.equal(Number(order.cost_clp),1200);
  });
  await t.test('ingreso/costo aprobado/conciliado, reporte y cierre conservan autoría y totales',async()=>{
   const revenue=await admin('patch','/api/economics/trips/:id/revenue',{revenue_clp:10000,revenue_includes_vat:true,reason:'Ingreso sintético pactado'},{id:trip.id},202);
   await ok(a.approver.token,'post','/api/economics/authorizations/:id/approve',{reason:'Aprobar ingreso posterior al inicio',password:h.password},{id:revenue.request.id});
   let initial=await admin('get',FIN,{}, {id:trip.id});
   await admin('post',FIN+'/budget',{version:Number(initial.control.version),reason:'Presupuesto de combustible sintético',entries:[{category_code:'fuel',amount_clp:1800,includes_vat:true}]},{id:trip.id},201);
   const fuels=[];
   for(const [date,odo] of [['2026-10-27',10000],['2026-10-28',10500]])fuels.push(await admin('post','/api/fleet/fuel',{truck_id:Number(vehicle.id),date,liters:100,price_clp:20,odometer_km:odo,station:'Estación sintética'},{},201));
   const history=await call(a.admin.token,'get','/api/fleet/fuel',{}, {},{truck_id:String(vehicle.id),include_summary:'true'});assert.equal(history.statusCode,200);assert.equal(history.payload.records[0].efficiency_km_l,5);assert.equal(history.payload.records[0].cost_per_km,4);assert.equal(history.payload.records[1].efficiency_km_l,null);
   const source=await admin('post','/api/economics/sources',{kind:'fuel',fuel_id:Number(fuels[1].id),includes_vat:true,description:'Origen sintético enlazado al registro'},{},201);
   assert.equal((await call(a.admin.token,'post','/api/economics/sources',{kind:'fuel',fuel_id:Number(fuels[1].id),includes_vat:true,description:'No duplicar'})).statusCode,409);
   initial=await admin('get',FIN,{}, {id:trip.id});
   const allocation=await admin('post','/api/economics/sources/:sourceId/allocate',{trip_id:Number(trip.id),version:Number(initial.control.version),source_version:0,amount_clp:2000,reason:'Combustible consumido por este servicio'},{sourceId:source.id},201);
   const item=await h.one('select id item_id,current_version_id version_id from trip_cost_items where id=$1',[allocation.cost_item_id]),cost=item;
   const request=await admin('post','/api/economics/authorizations',{trip_id:Number(trip.id),request_type:'cost_version',cost_version_id:Number(cost.version_id||cost.id),reason:'Revisión del gasto sintético'},{},201);
   await ok(a.approver.token,'post','/api/economics/authorizations/:id/approve',{reason:'Aprobación independiente sintética',password:h.password},{id:request.id});
   await admin('post','/api/economics/costs/:id/reconcile',{reason:'Conciliación sintética'},{id:cost.item_id},201);
   let state=await admin('get',FIN,{}, {id:trip.id});assert.equal(state.summary.delta_clp,8000);
   const report=await h.run(a.admin.token,'get','/api/economics/reports',{query:{report:'economic'}});assert.equal(report.statusCode,200);const reported=report.payload.rows.find(r=>String(r.trip_id)===String(trip.id));assert.ok(reported,'El reporte debe contener el viaje específico, no otro registro');assert.equal(reported.delta,8000);
   const dashboard=await admin('get','/api/economics/kpis');assert.equal(dashboard.economics.delta.reconciled,8000);assert.equal(dashboard.economics.recognized_revenue.amount,10000);
   const premature=await call(a.admin.token,'post',FIN+'/close',{version:Number(state.control.version),reason:'Sin reparto aún',password:h.password},{id:trip.id});assert.equal(premature.statusCode,409);assert.equal(premature.payload.code,'FINANCE_INCOMPLETE');
   await admin('post',FIN+'/distribution',{version:Number(state.control.version),basis_hash:state.basis_hash,entries:loads.map((l,i)=>({load_id:Number(l.id),revenue_clp:i?3000:4000,cost_clp:i?600:800})),reason:'Reparto sintético entre tres clientes'},{id:trip.id},201);
   state=await admin('get',FIN,{}, {id:trip.id});await admin('post',FIN+'/close',{version:Number(state.control.version),reason:'Cierre integral de aceptación',password:h.password},{id:trip.id});state=await admin('get',FIN,{}, {id:trip.id});assert.equal(state.control.state,'closed');assert.equal((await h.one('select status from trips where id=$1',[trip.id])).status,'Completado');
   const audit=await h.one("select count(*)::int n from audit_logs where company_id=$1 and user_id in ($2,$3)",[a.id,a.admin.id,a.approver.id]);assert.ok(audit.n>15);
   assert.equal(state.comparison.find(x=>x.category_code==='fuel').variance_clp,200);
   await admin('post',FIN+'/reopen',{version:Number(state.control.version),reason:'Revisión posterior sintética trazable',password:h.password},{id:trip.id});
   state=await admin('get',FIN,{}, {id:trip.id});assert.equal(state.control.state,'open');assert.equal(state.summary.delta_clp,8000);assert.equal(state.events.length,2);
   await admin('post',FIN+'/close',{version:Number(state.control.version),reason:'Segundo cierre sin cambiar importes',password:h.password},{id:trip.id});
   assert.equal((await admin('get',FIN,{}, {id:trip.id})).events.length,3);
  });
 }finally{await runtime.close();}
});
