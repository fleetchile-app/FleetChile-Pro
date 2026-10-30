'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../itinerary-coherence');
const point=(name,lat,lng)=>({name,lat,lng});
const plan=()=>({departure:'2026-11-01T08:00:00Z',stops:[{key:'a',location_id:1,location:point('Acceso A',-36,-73),service_minutes:0,wait_minutes:0,rest_minutes:0},{key:'b',location_id:2,location:point('Acceso B',-33,-70),service_minutes:0,wait_minutes:0,rest_minutes:0}],loads:[{load_id:9,pickup:'a',delivery:'b'}]});
const load=()=>({id:9,origin_location_id:1,destination_location_id:2,origin:'Acceso A',destination:'Acceso B',status:'Planificada'});

test('ubicación fiscal de cliente no es destino: sólo se comparan puntos operativos de la carga',()=>{
 assert.deepEqual(C.loadChanges(plan(),[{...load(),client_address:'Otra región'}]),[]);
 assert.equal(C.loadChanges(plan(),[{...load(),destination_location_id:3}])[0].field,'destination');
});
test('firma de ubicaciones detecta cambios de destinos, origen o texto independientemente del peso',()=>{
 const before=JSON.stringify(C.signature([load()]));
 for(const changes of [{destination_location_id:3},{origin_location_id:4},{destination:'Otro establecimiento'}])assert.notEqual(JSON.stringify(C.signature([{...load(),...changes}])),before);
 assert.equal(JSON.stringify(C.signature([{...load(),weight_kg:300}])),before);
});
test('cambiar punto confirmado requiere revisión pero falta de datos no se transforma en coordenadas',()=>{
 assert.equal(C.endpointChange({origin_location_id:1,destination_location_id:2},plan()),false);
 assert.equal(C.endpointChange({origin_location_id:1,destination_location_id:8},plan()),true);
 assert.equal(C.loadChanges(plan(),[{id:9,status:'Planificada'}]).length,2);
});
test('histórico entregado sin puntos no se rellena retroactivamente',()=>{
 assert.deepEqual(C.loadChanges(plan(),[{id:9,status:'Entregada'}]),[]);
});
test('cambiar el destino de la carga sin confirmación no ejecuta SQL ni auditoría',async()=>{
 let calls=0;await assert.rejects(C.reconcileLoads({query(){calls++;}}, {},{id:1},plan(),[{...load(),destination_location_id:3}],[],false,'Cambio'),e=>e.code==='ITINERARY_LOCATION_CONFLICT');assert.equal(calls,0);
});
test('paradas iniciadas conservan coordenadas, tiempos y salida; las pendientes sí admiten modificación',()=>{
 const old=plan(),changed=plan(),events=[{kind:'arrive',stop_key:'a'}];
 changed.stops[1].location.lat=-34;assert.doesNotThrow(()=>C.preserveHistory(old,changed,events));
 changed.stops[0].location.lat=-35;assert.throws(()=>C.preserveHistory(old,changed,events));
 changed.stops[0].location.lat=-36;changed.stops[0].wait_minutes=20;assert.throws(()=>C.preserveHistory(old,changed,events));
 changed.stops[0].wait_minutes=0;changed.departure='2026-11-02T08:00:00Z';assert.throws(()=>C.preserveHistory(old,changed,events));
});
test('revisión de accesos usa empresa y puntos persistidos, no coordenadas enviadas por el navegador',async()=>{
 const sql=[],db={async query(text,values){sql.push({text,values});return {rows:text.includes('from trips')?[{origin_location_id:1,destination_location_id:2,origin:'Acceso A',destination:'Acceso B'}]:[{id:1,lat:-36,lng:-73},{id:2,lat:-33,lng:-70}]};}};
 await C.verify(db,{id:7,company_id:10},plan(),[load()]);assert.deepEqual(sql[1].values,[10,[1,2]]);assert.match(sql[1].text,/company_id=\$1/);
 const moved=plan();moved.stops[1].location.lat=-32;await assert.rejects(C.verify(db,{id:7,company_id:10},moved,[load()]));
});
