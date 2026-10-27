'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),E=require('../equipment-domain');
test('tipos conocidos se normalizan sin convertir tipos desconocidos en equipos compatibles',()=>{
 assert.equal(E.role('Tractocamión'),'tractor');assert.equal(E.role('Semirremolque'),'trailer');assert.equal(E.role('Camión'),'truck');assert.equal(E.role('Equipo'),'equipment');assert.equal(E.role('Texto libre desconocido'),null);
 const tractor={id:1,tipo:'tractocamion'},trailer={id:2,tipo:'remolque'};E.pair(tractor,trailer);
 assert.throws(()=>E.pair(trailer,null));assert.throws(()=>E.pair(tractor,{...trailer,id:1}));assert.throws(()=>E.pair(tractor,{id:2,tipo:'camion'}));assert.throws(()=>E.pair({id:3,tipo:'equipo'},trailer));
});
test('capacidad del acoplado no se suma a cabina ni sustituye un dato desconocido',()=>{
 const tractor={id:1,tipo:'tractocamion',capacidad_t:10},trailer={id:2,tipo:'remolque',capacidad_t:20};
 assert.equal(E.capacity(tractor,trailer),20);assert.equal(E.capacity(tractor,null),null);assert.equal(E.capacity(tractor,{...trailer,capacidad_t:null}),null);
 assert.equal(E.capacity({tipo:'camion',capacidad_t:'10'},null),10);assert.equal(E.capacity({tipo:'camion',capacidad_t:-1},null),null);
});
test('vigencia cubre la reserva completa; ejecución se reevalúa al tiempo real',()=>{
 const s={valid_from:'2026-10-01T00:00:00Z',valid_until:'2026-11-01T00:00:00Z'};
 E.windowCheck(s,{plannedDeparture:'2026-10-26T08:00:00Z',plannedArrival:'2026-10-26T18:00:00Z'});
 for(const options of [{plannedDeparture:'2026-09-26T08:00:00Z',plannedArrival:'2026-10-26T18:00:00Z'},{plannedDeparture:'2026-10-26T08:00:00Z'},{status:'En tránsito',now:new Date('2026-11-02T00:00:00Z'),plannedArrival:'2026-11-03T00:00:00Z'}])assert.throws(()=>E.windowCheck(s,options),e=>e.code==='COMPOSITION_OUTSIDE_WINDOW');
 E.windowCheck({valid_from:'2000-01-01T00:00:00Z'},{status:'En tránsito'});
});
test('validadores rechazan identidad ambigua y fecha imposible; permiten versión cero inicial',()=>{
 for(const v of [true,{},[],1.5,-1,''])assert.throws(()=>E.id(v));assert.equal(E.id(0,'Versión',{zero:true}),0);
 assert.throws(()=>E.instant('2026-02-30T10:00:00Z','Vigencia'));assert.throws(()=>E.instant('2026-10-26T10:00','Vigencia'));assert.throws(()=>E.text('<x>'.repeat(1000),'Motivo',160));
});
