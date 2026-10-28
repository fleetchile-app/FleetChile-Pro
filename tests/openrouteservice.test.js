'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createGeocoder}=require('../geocoding'),{createRoutingAdapter}=require('../routing');
const {limits}=require('../ors-budget');
const key=()=>crypto.randomUUID(),origin={lat:-36,lng:-73},destination={lat:-33,lng:-70};
const route=()=>({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'LineString',coordinates:[[-73,-36],[-70,-33]]},properties:{summary:{distance:123456,duration:7200}}}]});
const point=()=>({type:'FeatureCollection',features:[{geometry:{type:'Point',coordinates:[-73,-36]},properties:{name:'Planta sintética',label:'Planta sintética, Chile',country_a:'CHL',locality:'Comuna sintética',region:'Región sintética',gid:'test:1'}}]});
const response=data=>({ok:true,json:async()=>data});
test('ORS: geocodificación server-side limita Chile y sólo devuelve datos normalizados',async()=>{
 let sent;const apiKey=key(),geocoder=createGeocoder({provider:'openrouteservice',apiKey,budget:async()=>{},fetchImpl:async(url,options)=>{sent={url,options};return response(point());}});
 const rows=await geocoder.search('Planta sintética');assert.equal(rows[0].source,'openrouteservice');assert.equal(rows[0].lat,-36);assert.equal(sent.url.hostname,'api.openrouteservice.org');assert.equal(sent.url.searchParams.get('boundary.country'),'CHL');assert.equal(sent.url.searchParams.get('size'),'5');assert.equal(sent.url.searchParams.get('api_key'),apiKey);assert.ok(!JSON.stringify(rows).includes(apiKey));
});
test('ORS: GeoJSON, coordenadas lon/lat, metros, segundos y distancia de acceso sin alterar los km viales',async()=>{
 let sent;const apiKey=key(),adapter=createRoutingAdapter({provider:'openrouteservice',apiKey,budget:async()=>{},fetchImpl:async(url,options)=>{sent={url,options};return response(route());}}),result=await adapter.route(origin,destination);
 assert.equal(sent.url.pathname,'/v2/directions/driving-car/geojson');assert.equal(sent.options.headers.Authorization,apiKey);assert.equal(sent.url.searchParams.has('api_key'),false);assert.deepEqual(JSON.parse(sent.options.body).coordinates,[[-73,-36],[-70,-33]]);assert.equal(result.distance_meters,123456);assert.equal(result.duration_seconds,7200);assert.equal(result.snapped_points[0].distance,0);assert.match(result.attribution,/HeiGIT/);
 const hgv=createRoutingAdapter({provider:'openrouteservice',profile:'driving-hgv',apiKey:key(),budget:async()=>{},fetchImpl:async(url)=>{assert.match(url.pathname,/driving-hgv/);return response(route());}});assert.equal((await hgv.route(origin,destination)).provider,'openrouteservice/driving-hgv');
});
test('ORS: sin clave, sin presupuesto o con coordenadas/perfil inválidos no emite peticiones',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return response(route());};
 await assert.rejects(createRoutingAdapter({provider:'openrouteservice',apiKey:'',fetchImpl}).route(origin,destination),e=>e.code==='configuration_error');
 await assert.rejects(createRoutingAdapter({provider:'openrouteservice',apiKey:key(),fetchImpl}).route(origin,destination),e=>e.code==='configuration_error');
 await assert.rejects(createRoutingAdapter({provider:'openrouteservice',apiKey:key(),fetchImpl}).route({lat:true,lng:-73},destination),e=>e.code==='invalid_coordinates');
 await assert.rejects(createRoutingAdapter({provider:'openrouteservice',profile:'unknown',apiKey:key(),fetchImpl}).route(origin,destination),e=>e.code==='configuration_error');assert.equal(calls,0);
});
test('ORS: cuota consumida una vez, deduplicación concurrente, caché con fecha original y copias independientes',async()=>{
 let calls=0,used=0,at=new Date('2026-10-27T10:00:00Z');const adapter=createRoutingAdapter({provider:'openrouteservice',apiKey:key(),now:()=>at,budget:async()=>{used++;},fetchImpl:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return response(route());}});
 const [a,b]=await Promise.all([adapter.route(origin,destination),adapter.route(origin,destination)]);assert.equal(calls,1);assert.equal(used,1);a.geometry.coordinates[0][0]=0;assert.equal(b.geometry.coordinates[0][0],-73);
 at=new Date('2026-10-27T10:01:00Z');const c=await adapter.route(origin,destination);assert.equal(c.calculated_at,'2026-10-27T10:00:00.000Z');assert.equal(calls,1);at=new Date('2026-10-27T10:11:00Z');await adapter.route(origin,destination);assert.equal(calls,2);
});
test('ORS: claves diferentes no comparten caché ni presupuesto',async()=>{let calls=0;for(let i=0;i<2;i++)await createRoutingAdapter({provider:'openrouteservice',apiKey:key(),budget:async()=>{},fetchImpl:async()=>{calls++;return response(route());}}).route(origin,destination);assert.equal(calls,2);});
test('ORS: 401, 403, 429, HTTP fallido y red nunca filtran claves ni cuerpos del proveedor',async()=>{
 for(const status of [401,403,429,500]){const apiKey=key(),adapter=createRoutingAdapter({provider:'openrouteservice',apiKey,budget:async()=>{},fetchImpl:async()=>({ok:false,status,json:async()=>({error:{message:apiKey}})})});await assert.rejects(adapter.route(origin,destination),e=>!e.message.includes(apiKey)&&(status!==429||e.code==='quota_exceeded'));}
 const apiKey=key(),adapter=createRoutingAdapter({provider:'openrouteservice',apiKey,budget:async()=>{},fetchImpl:async()=>{throw Error(apiKey);}});await assert.rejects(adapter.route(origin,destination),e=>!e.message.includes(apiKey));
});
test('ORS: respuestas malformadas o distancias nulas se rechazan; sin ruta no inventa resultados',async()=>{
 for(const data of [{}, {...route(),features:[]}, {...route(),features:[{...route().features[0],properties:{summary:{distance:null,duration:1}}}]}])await assert.rejects(createRoutingAdapter({provider:'openrouteservice',apiKey:key(),budget:async()=>{},fetchImpl:async()=>response(data)}).route(origin,destination),e=>e.code==='invalid_result');
 assert.equal(await createRoutingAdapter({provider:'openrouteservice',apiKey:key(),budget:async()=>{},fetchImpl:async()=>response({error:{code:2009}})}).route(origin,destination),null);
 const data=point();data.features[0].properties.country_a='ARG';assert.deepEqual(await createGeocoder({provider:'openrouteservice',apiKey:key(),budget:async()=>{},fetchImpl:async()=>response(data)}).search('Planta sintética'),[]);
});
test('ORS: topes conservadores configurables, sin convertir datos inválidos en cuotas ilimitadas',()=>{assert.deepEqual(limits('directions',{}),{daily:2000,minute:40});assert.equal(limits('geocoding',{}).daily,1000);assert.equal(limits('directions',{ORS_DIRECTIONS_DAILY_LIMIT:'bad'}).daily,2000);});
test('ORS: selector reconoce el proveedor sin depender de las BASE_URL heredadas',async()=>{
 const handlers={},app={get(){},post(path,...h){handlers[path]=h;}};const {registerLocationPickerRoutes}=require('../location-picker-api');
 registerLocationPickerRoutes(app,{query:async()=>({rows:[{id:1,...origin},{id:2,...destination}]})},createGeocoder({provider:'openrouteservice',apiKey:''}),createRoutingAdapter({provider:'openrouteservice',apiKey:''}),{env:{}});
 for(const endpoint of ['search','route']){const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;}};await handlers['/api/location-picker/'+endpoint][1]({body:{query:'Planta sintética',origin_location_id:1,destination_location_id:2},locationCompanyId:10},res);assert.match(res.payload.error,/ORS_API_KEY/);assert.ok([502,503].includes(res.statusCode));}
});
test('ORS: respuesta inválida no contamina la caché y fallo de presupuesto no llama a HTTP',async()=>{
 let calls=0;const adapter=createRoutingAdapter({provider:'openrouteservice',apiKey:key(),budget:async()=>{},fetchImpl:async()=>{calls++;return response(calls===1?{}:route());}});await assert.rejects(adapter.route(origin,destination),e=>e.code==='invalid_result');assert.equal((await adapter.route(origin,destination)).distance_meters,123456);assert.equal(calls,2);
 await assert.rejects(createRoutingAdapter({provider:'openrouteservice',apiKey:key(),budget:async()=>{throw Object.assign(Error('Presupuesto no disponible'),{code:'budget_unavailable'});},fetchImpl:async()=>{throw Error('HTTP no debe ejecutarse');}}).route(origin,destination),e=>e.code==='budget_unavailable');
});
test('ORS: rutas grandes se devuelven sin retenerlas en caché ni propagar campos extra',async()=>{
 let calls=0;const large=route();large.features[0].geometry.coordinates=Array.from({length:50000},()=>[-73.123456789,-36.123456789]);large.features[0].geometry.private_metadata='not-for-clients';
 const adapter=createRoutingAdapter({provider:'openrouteservice',apiKey:key(),budget:async()=>{},fetchImpl:async()=>{calls++;return response(large);}});
 const result=await adapter.route(origin,destination);assert.equal(result.geometry.coordinates.length,50000);assert.equal(result.geometry.private_metadata,undefined);await adapter.route(origin,destination);assert.equal(calls,2);
});
