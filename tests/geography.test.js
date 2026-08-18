const test=require('node:test');
const assert=require('node:assert/strict');
const {registerGeographyRoutes}=require('../geography-api');
const {GeocodingError,createNominatimGeocoder}=require('../geocoding');

function fakeApp(){
  const routes=[];
  routes.post=(path,...handlers)=>routes.push({method:'post',path,handlers});
  routes.route=path=>{const route=routes.find(item=>item.path===path);assert.ok(route,`Ruta no registrada: POST ${path}`);return route};
  return routes;
}

function response(){return {statusCode:200,payload:undefined,status(code){this.statusCode=code;return this},json(value){this.payload=value;return this},sendStatus(code){this.statusCode=code;return this}}}

async function invoke(route,overrides={}){
  const req={user:{id:5,role_code:'operations',company_id:10,permissions:['trips.manage']},body:{},ip:'127.0.0.1',...overrides};
  const res=response();let index=0;
  const next=async()=>{const handler=route.handlers[index++];if(handler)return handler(req,res,next)};
  await next();return {req,res};
}

function transactionalPool(resolver){
  const calls=[];
  const client={calls,async query(sql,values=[]){calls.push({sql,values});return resolver(sql,values,calls)},release(){calls.push({sql:'RELEASE',values:[]})}};
  return {calls,async connect(){return client},async query(sql,values=[]){return client.query(sql,values)}};
}

const normalized={name:'Terminal Santiago',address:'Terminal Santiago, Estación Central, Región Metropolitana, Chile',commune:'Estación Central',region:'Región Metropolitana de Santiago',lat:-33.456,lng:-70.71,source:'nominatim',external_id:'way:123',normalized_at:'2026-08-18T15:00:00.000Z'};

test('adaptador Nominatim convierte la respuesta del proveedor al contrato de ubicación',async()=>{
  let requested;
  const geocoder=createNominatimGeocoder({userAgent:'FleetChile-Pro tests',now:()=>new Date('2026-08-18T15:00:00Z'),fetchImpl:async(url,options)=>{requested={url,options};return {ok:true,async json(){return [{lat:'-33.456',lon:'-70.710',name:'Terminal Santiago',display_name:'Terminal Santiago, Estación Central, Región Metropolitana, Chile',osm_type:'way',osm_id:123,address:{city:'Estación Central',state:'Región Metropolitana de Santiago'}}]}}}});
  assert.deepEqual(await geocoder.geocode('Terminal Santiago'),normalized);
  assert.equal(requested.url.searchParams.get('q'),'Terminal Santiago');
  assert.equal(requested.url.searchParams.get('countrycodes'),'cl');
  assert.equal(requested.options.headers['User-Agent'],'FleetChile-Pro tests');
});

test('geocodificación devuelve una ubicación normalizada sin persistirla',async()=>{
  const pool={async connect(){throw new Error('No debe persistir')}},geocoder={async geocode(query){assert.equal(query,'Terminal Santiago');return normalized}};
  const app=fakeApp();registerGeographyRoutes(app,pool,geocoder);
  const {res}=await invoke(app.route('/api/geography/geocode'),{body:{query:' Terminal Santiago '}});
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.payload,normalized);
});

test('geografía rechaza consultas y resultados con coordenadas inválidas',async()=>{
  let calls=0;
  const geocoder={async geocode(){calls++;return {...normalized,lat:91}}};
  const app=fakeApp();registerGeographyRoutes(app,{},geocoder);
  let result=await invoke(app.route('/api/geography/geocode'),{body:{query:'   '}});
  assert.equal(result.res.statusCode,400);
  assert.equal(calls,0);
  result=await invoke(app.route('/api/geography/geocode'),{body:{query:'Ubicación inválida'}});
  assert.equal(result.res.statusCode,502);
  assert.equal(calls,1);
});

test('geocodificación maneja ausencia de resultados y errores del proveedor',async()=>{
  const appNoResult=fakeApp();registerGeographyRoutes(appNoResult,{}, {async geocode(){return null}});
  const noResult=await invoke(appNoResult.route('/api/geography/geocode'),{body:{query:'Dirección inexistente'}});
  assert.equal(noResult.res.statusCode,404);
  const appFailure=fakeApp();registerGeographyRoutes(appFailure,{}, {async geocode(){throw new GeocodingError('Fallo remoto')}});
  const failure=await invoke(appFailure.route('/api/geography/geocode'),{body:{query:'Santiago'}});
  assert.equal(failure.res.statusCode,502);
});

test('creación persiste la ubicación normalizada con company scope y auditoría',async()=>{
  const saved={id:71,company_id:10,...normalized,name:'Centro de distribución'};
  const pool=transactionalPool(async(sql,values)=>{
    if(sql==='BEGIN'||sql==='COMMIT')return {rowCount:0,rows:[]};
    if(sql.startsWith('insert into operational_locations'))return {rowCount:1,rows:[saved]};
    if(sql.startsWith('insert into audit_logs'))return {rowCount:1,rows:[]};
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();registerGeographyRoutes(app,pool,{async geocode(){return normalized}});
  const {res}=await invoke(app.route('/api/geography/locations'),{body:{query:'Terminal Santiago',name:'Centro de distribución',company_id:999}});
  assert.equal(res.statusCode,201);
  assert.deepEqual(res.payload,saved);
  const insert=pool.calls.find(call=>call.sql.startsWith('insert into operational_locations'));
  assert.deepEqual(insert.values,[10,'Centro de distribución',normalized.address,normalized.commune,normalized.region,normalized.lat,normalized.lng,'nominatim','way:123',normalized.normalized_at]);
  const audit=pool.calls.find(call=>call.sql.startsWith('insert into audit_logs'));
  assert.deepEqual(audit.values,[10,5,'create','operational_location','71',null,saved,'127.0.0.1']);
  assert.ok(pool.calls.indexOf(insert)<pool.calls.indexOf(audit));
  assert.ok(pool.calls.indexOf(audit)<pool.calls.findIndex(call=>call.sql==='COMMIT'));
});

test('administrador debe indicar explícitamente la empresa propietaria',async()=>{
  let geocodeCalls=0;
  const app=fakeApp();registerGeographyRoutes(app,{}, {async geocode(){geocodeCalls++;return normalized}});
  const {res}=await invoke(app.route('/api/geography/locations'),{user:{id:1,role_code:'admin',company_id:null,permissions:[]},body:{query:'Santiago'}});
  assert.equal(res.statusCode,400);
  assert.equal(geocodeCalls,0);
});

test('fallo de auditoría revierte la persistencia de la ubicación',async()=>{
  const pool=transactionalPool(async(sql)=>{
    if(sql==='BEGIN'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
    if(sql.startsWith('insert into operational_locations'))return {rowCount:1,rows:[{id:72,company_id:10,...normalized}]};
    if(sql.startsWith('insert into audit_logs'))throw new Error('audit failure');
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  const app=fakeApp();registerGeographyRoutes(app,pool,{async geocode(){return normalized}});
  const {res}=await invoke(app.route('/api/geography/locations'),{body:{query:'Terminal Santiago'}});
  assert.equal(res.statusCode,400);
  assert.equal(pool.calls.some(call=>call.sql==='ROLLBACK'),true);
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
});
