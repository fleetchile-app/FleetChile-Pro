'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),D=require('../itinerary-domain');
const raw=()=>({departure:'2026-11-01T08:00:00Z',contingency_minutes:10,vehicle_review:{acknowledged:true,notes:'Revisión operacional de prueba'},stops:[{key:'a',location_id:1,purpose:'pickup',service_minutes:20},{key:'b',location_id:2,purpose:'mixed',wait_minutes:5},{key:'c',location_id:3,purpose:'delivery',rest_minutes:10}],loads:[{load_id:1,pickup:'a',delivery:'b'},{load_id:2,pickup:'b',delivery:'c'}]});
const leg={distance_meters:1000,duration_seconds:600,geometry:{type:'LineString',coordinates:[[0,0],[1,0]]},provider:'fixture',calculated_at:'2026-10-26T00:00:00Z'};
test('normalización exige paradas únicas, orden, propósito y revisión explícita',()=>{
 const p=D.normalize(raw());assert.equal(p.stops.length,3);assert.throws(()=>D.normalize({...raw(),vehicle_review:{acknowledged:false}}));
 const b=raw();b.loads[0].delivery='a';assert.throws(()=>D.normalize(b),/después/);
 b.loads[0].delivery='b';b.stops[1].key='a';assert.throws(()=>D.normalize(b),/distintos/);
 assert.throws(()=>D.normalize({...raw(),departure:'2026-02-30T08:00:00Z'}));
});
test('capacidad se calcula por tramo: descarga antes de recoger, sin sumar cargas de todo el viaje',()=>{
 const p=D.normalize(raw()),loads=[{id:1,weight_kg:6000},{id:2,weight_kg:6000}],c=D.capacityPlan(p.stops,p.loads,loads,10);
 assert.deepEqual(c.segments.map(s=>s.weight_kg),[6000,6000]);assert.equal(c.overloaded,false);assert.equal(c.verified,true);
 p.loads[1].pickup='a';assert.equal(D.capacityPlan(p.stops,p.loads,loads,10).overloaded,true);
});
test('peso desconocido o capacidad faltante no equivalen a cero verificado',()=>{
 const p=D.normalize(raw());assert.equal(D.capacityPlan(p.stops,p.loads,[{id:1,weight_kg:0},{id:2,weight_kg:2000}],10).verified,false);
 assert.equal(D.capacityPlan(p.stops,p.loads,[{id:1,weight_kg:1000},{id:2,weight_kg:2000}],null).verified,false);
 assert.throws(()=>D.capacityPlan(p.stops,p.loads,[],10),/pertenece/);
});
test('una entrega fallida mantiene el peso a bordo; una parcial sólo descuenta lo efectivamente entregado',()=>{
 const p=D.normalize(raw()),loads=[{id:1,weight_kg:6000},{id:2,weight_kg:6000}],failed=[{kind:'failed',load_id:1,stop_key:'b'}];
 const c=D.capacityPlan(p.stops,p.loads,loads,10,failed);assert.equal(c.segments[1].weight_kg,12000);assert.equal(c.overloaded,true);
 const partial=D.capacityPlan(p.stops,p.loads,loads,10,[...failed,{kind:'partial',load_id:1,stop_key:'b',delivered_kg:3000}]);assert.equal(partial.segments[1].weight_kg,9000);assert.equal(partial.overloaded,false);
});
test('conducción, detenciones y contingencia se suman una sola vez',()=>{
 const p=D.schedule(D.normalize(raw()),[leg,leg]);assert.equal(p.driving_seconds,1200);assert.equal(p.stop_seconds,2100);assert.equal(p.total_seconds,3900);assert.equal(p.arrival,'2026-11-01T09:05:00.000Z');assert.equal(p.stops[1].planned_arrival,'2026-11-01T08:30:00.000Z');
});
test('el cambio de capacidad no reescribe la capacidad de tramos ya recorridos',()=>{
 const p=D.normalize(raw()),loads=[{id:1,weight_kg:9000},{id:2,weight_kg:6000}],c=D.capacityPlan(p.stops,p.loads,loads,7,[],[10000,undefined]);
 assert.deepEqual(c.segments.map(s=>s.capacity_kg),[10000,7000]);assert.equal(c.overloaded,false);
});
test('demora absorbida por una llegada real no vuelve a sumarse a la ETA',()=>{
 const p=D.schedule(D.normalize(raw()),[leg,leg]),now=new Date('2026-11-01T08:40:00Z'),events=[{stop_key:'a',kind:'depart',occurred_at:'2026-11-01T08:20:00Z'},{kind:'delay',minutes:10,occurred_at:'2026-11-01T08:21:00Z'},{stop_key:'b',kind:'arrive',occurred_at:'2026-11-01T08:35:00Z'}];
 assert.equal(D.eta(p,events,null,now).delay_seconds,0);
});
test('proveedor incompleto, geometría inválida o magnitud inventada se rechazan',()=>{
 assert.equal(D.routeValid(leg),true);assert.equal(D.routeValid({...leg,distance_meters:'1000'}),false);assert.equal(D.routeValid({...leg,duration_seconds:NaN}),false);assert.equal(D.routeValid({...leg,geometry:{type:'LineString',coordinates:[[0,91],[1,0]]}}),false);
});
test('paradas iniciadas y recogidas no se reescriben al reprogramar entregas futuras',()=>{
 const p=D.normalize(raw()),n=D.normalize(raw());n.stops.reverse();assert.throws(()=>D.preserveProgress(p,n,[{stop_key:'a',kind:'arrive'}]),/iniciada/);
 const v=D.normalize(raw());v.loads[0].pickup='b';assert.throws(()=>D.preserveProgress(p,v,[{stop_key:'a',kind:'depart'}]),/recogidas/);
});
test('ETA usa avance sobre el trazado guardado y declara GPS antiguo o fuera de ruta',()=>{
 const p=D.schedule(D.normalize(raw()),[leg,leg]),now=new Date('2026-11-01T08:25:00Z'),events=[{stop_key:'a',kind:'depart',occurred_at:'2026-11-01T08:20:00Z'}];
 const gps={lat:0,lng:0.5,recorded_at:now.toISOString()},r=D.eta(p,events,gps,now);assert.equal(r.state,'gps_estimate');assert.equal(r.next_stop,'b');
 assert.equal(D.eta(p,events,{...gps,recorded_at:'2026-11-01T07:00:00Z'},now).state,'stale_gps');assert.equal(D.eta(p,events,{...gps,lat:5},now).state,'off_route');
 const delayed=D.eta(p,[...events,{kind:'delay',minutes:30}],gps,now);assert.equal(Date.parse(delayed.estimated_arrival)-Date.parse(r.estimated_arrival),1800000);
});
