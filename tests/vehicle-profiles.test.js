const test=require('node:test');const assert=require('node:assert/strict');
const {bodyOf,date,actor}=require('../vehicle-profile-api');const {assertVehicleRoadReady}=require('../vehicle-readiness');

test('fallo al calcular fecha empresarial revierte el alta antes de confirmar',async()=>{
 const routes=[],app={get(){},patch(){},post(path,...handlers){routes.push({path,handler:handlers.at(-1)});}},calls=[];let released=false;
 const db={async query(sql){calls.push(sql);if(sql.startsWith('select time_zone'))throw Error('Detalles internos de prueba');return {rows:sql.startsWith('insert into trucks')?[{id:7,company_id:10}]:[],rowCount:1};},release(){released=true;}};
 require('../vehicle-profile-api').registerVehicleProfileRoutes(app,{connect:async()=>db});
 const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;}};
 await routes.find(r=>r.path==='/api/fleet/vehicles').handler({user:{id:1,actor_type:'company',scope:'company',company_id:10,membership_id:2,permissions:['fleet.manage']},body:{patente:'BBJJ25',brand:'Marca',model:'Modelo',tipo:'Camión'}},res);
 assert.equal(res.statusCode,500);assert.doesNotMatch(res.payload.error,/internos/);
 assert.equal(calls.includes('COMMIT'),false);assert.equal(calls.at(-1),'ROLLBACK');assert.equal(released,true);
});
test('valida perfil sin aceptar conductor, ubicación ni kilometraje',()=>{assert.throws(()=>bodyOf({body:{patente:'AA',brand:'X',model:'Y',tipo:'camión',driver_id:3}}),/no modifica conductor/);assert.throws(()=>bodyOf({body:{patente:'AA',brand:'X',model:'Y',tipo:'camión',capacity_t:-1}}),/capacidad/);});
test('permite alta sin fechas y valida fechas ISO',()=>{const v=bodyOf({body:{patente:'AA',brand:'X',model:'Y',tipo:'camión'}});assert.equal(v.circulation_expiry,undefined);assert.throws(()=>bodyOf({body:{patente:'AA',brand:'X',model:'Y',tipo:'camión',soap_expiry:'2026-2-1'}}),/Fecha/);});

test('campos opcionales vacíos no impiden registrar; los obligatorios no se borran con null',()=>{
 const v=bodyOf({body:{patente:'AA',brand:'X',model:'Y',tipo:'tractocamion',vin:'',engine_number:'  ',capacity_t:null}});
 assert.equal(v.vin,null);assert.equal(v.engine_number,null);assert.equal(v.capacidad_t,null);
 for(const key of ['patente','brand','model','tipo'])assert.throws(()=>bodyOf({body:{[key]:null}},true),/obligatorio/);
});
test('rechaza fechas que Date.parse normalizaría y exige contexto empresarial seleccionado',()=>{assert.throws(()=>date('2026-02-31'),/Fecha/);assert.throws(()=>actor({user:{actor_type:'platform',scope:'platform',platform_membership_id:1,permissions:['fleet.manage']}}),e=>e.status===403);assert.equal(actor({user:{actor_type:'company',scope:'company',company_id:10,membership_id:2,permissions:['dashboard.read']}}).company_id,10);});

test('propietario activo conserva privilegios existentes solo en contexto empresarial seleccionado',()=>{
 const user={actor_type:'platform',scope:'platform',platform_membership_id:1,ownership_role:'primary',ownership_active:true,active_company_context:10,permissions:[]};
 assert.equal(actor({user}).company_id,10);
 assert.throws(()=>actor({user:{...user,active_company_context:null}}),e=>e.status===403);
 assert.throws(()=>actor({user:{...user,ownership_active:false}}),e=>e.status===403);
});
test('readiness exige los tres documentos y reporta faltantes/expirados',async()=>{const db={query:async sql=>sql.startsWith('select time_zone')?{rows:[{time_zone:'America/Santiago'}]}:{rows:[{id:4,status:'Activo',document_expiries:{circulation:{expires_at:'2026-01-01',status:'Vigente'},soap:{expires_at:'2027-01-01',status:'Vigente'}}}]}};await assert.rejects(assertVehicleRoadReady(db,{companyId:10,truckId:4,now:'2026-10-22'}),e=>e.code==='VEHICLE_NOT_ROAD_READY'&&e.details.missing.includes('inspection')&&e.details.expired.includes('circulation'));});
