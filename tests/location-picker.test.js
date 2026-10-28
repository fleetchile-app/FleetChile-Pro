'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {registerLocationPickerRoutes}=require('../location-picker-api'),{bindLocations}=require('../location-binding');
function setup(pool={},router={}){const routes=[],app={};for(const method of ['get','post'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});registerLocationPickerRoutes(app,pool,{},router,{env:{GEOCODING_BASE_URL:'https://geocode.example.invalid',ROUTING_BASE_URL:'https://route.example.invalid'}});return async(method,path,{user={id:1,actor_type:'company',scope:'company',company_id:10,role_code:'operations',permissions:['trips.manage']},body={},query={}}={})=>{const req={user,body,query,ip:'127.0.0.1'},res={statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.payload=data;return this;}};const route=routes.find(r=>r.method===method&&r.path==='/api/location-picker/'+path);async function next(i){let pending;if(route.handlers[i]){await route.handlers[i](req,res,()=>pending=next(i+1));if(pending)await pending;}}await next(0);return res;};}
test('selector exige permiso y empresa resuelta; nunca acepta company_id del formulario',async()=>{
 const seen=[],run=setup({async query(sql,args){seen.push(args);return {rows:[]};}});
 const base={id:1,actor_type:'company',scope:'company',company_id:10,role_code:'viewer',permissions:[]};
 assert.equal((await run('get','locations',{user:base})).statusCode,403);
 assert.equal((await run('get','locations',{user:{...base,scope:'platform',actor_type:'platform',company_id:null,permissions:['trips.manage']},query:{company_id:20}})).statusCode,403);
 assert.equal((await run('get','locations',{user:null})).statusCode,401);
 assert.equal((await run('get','locations',{query:{company_id:20}})).statusCode,200);assert.equal(seen[0][0],10);
});
test('cargas puede reutilizar ubicaciones sin otorgarle trips.manage',async()=>{const run=setup({query:async()=>({rows:[]})});assert.equal((await run('get','locations',{user:{id:1,actor_type:'company',scope:'company',company_id:10,role_code:'custom',permissions:['loads.manage']}})).statusCode,200);});
test('catálogo consulta jerarquía por parámetros y no descarga geografía en cada uso',async()=>{const calls=[],run=setup({async query(sql,args){calls.push({sql,args});return {rows:[]};}});assert.equal((await run('get','catalog',{query:{region_id:'3',commune_id:'4',q:"x' OR 1=1"}})).statusCode,200);assert.deepEqual(calls[1].args,[3]);assert.deepEqual(calls[2].args,[4,"%x' OR 1=1%"]);assert.equal((await run('get','catalog',{query:{region_id:'bad'}})).statusCode,400);});
test('punto de mapa rechaza coordenadas vacías, booleanas, fuera de rango y sin comuna antes de escribir',async()=>{const run=setup({connect(){throw Error('No debe conectar');}});for(const lat of [null,'',true,91,'bad'])assert.equal((await run('post','locations',{body:{name:'Planta',lat,lng:-70,commune_id:1}})).statusCode,400);});
test('binding mantiene compatible el texto histórico, pero rechaza referencias parciales o cruzadas',async()=>{
 const row={id:1,origin:'Histórico'},noQueries={query(){throw Error('No consultar para legacy');}};assert.equal(await bindLocations(noQueries,'trips',row,{},10),row);
 await assert.rejects(bindLocations(noQueries,'trips',row,{origin_location_id:2},10),/Confirma|Selecciona/);
 await assert.rejects(bindLocations({query:async()=>({rows:[{id:2,name:'A'}]})},'trips',row,{origin_location_id:2,destination_location_id:3},10),/empresa/);
});
test('binding exige cálculo del mismo par y confirmación de acceso separado de la carretera',async()=>{
 const base={origin_location_id:2,destination_location_id:3,road_route_id:8},points=[{id:2,name:'A'},{id:3,name:'B'}];
 await assert.rejects(bindLocations({query:async sql=>({rows:sql.includes('operational_locations')?points:[]})},'routes',{id:1},base,10),/no corresponde/);
 await assert.rejects(bindLocations({query:async sql=>({rows:sql.includes('operational_locations')?points:[{id:8,snapped_points:[{distance:101}]}]})},'routes',{id:1},base,10),/Confirma/);
});
test('catálogo INE conserva 9378 puntos reales con fuente y versión; no asigna accesos a viajes',()=>{
 const sql=fs.readFileSync(require.resolve('../migrations/044_seed_ine_localities_2024.sql'),'utf8');assert.equal((sql.match(/\('INE-CPV24-TOPO-/g)||[]).length,9378);assert.match(sql,/INE Censo de Poblacion y Vivienda 2024/);assert.doesNotMatch(sql,/UPDATE\s+(?:trips|routes|loads)|DELETE\s+FROM/i);assert.match(sql,/ON CONFLICT\(official_code\) DO NOTHING/);
});
test('selector queda sujeto al módulo operacional existente',()=>{assert.equal(require('../commercial-domain').moduleFor('/api/location-picker/route'),'operations');});
test('servidores públicos de búsqueda y ruteo no se ofrecen como proveedores comerciales',async()=>{
 const handlers={},app={get(){},post(path,...h){handlers[path]=h;}};let calls=0;registerLocationPickerRoutes(app,{}, {geocode:async()=>calls++},{route:async()=>calls++},{env:{}});
 for(const endpoint of ['search','route']){const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;}};await handlers['/api/location-picker/'+endpoint][1]({body:{query:'Dirección',origin_location_id:1,destination_location_id:2},locationCompanyId:10},res);assert.equal(res.statusCode,503);assert.match(res.payload.error,/proveedor/);}assert.equal(calls,0);
});
