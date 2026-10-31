'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function surface(){
 const calls=[],detail={isConnected:true,innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]};
 const root={querySelector:s=>s==='.driver-detail'?detail:s==='#backTrips'?{}:null,querySelectorAll:()=>[]};
 let finish;
 const sandbox={window:{DriverMobile:{workflow:async()=>{calls.push('workflow');await new Promise(r=>finish=r);}},DriverOuting:{mount:async()=>calls.push('outing'),pause:()=>calls.push('pause')}},document:{getElementById:()=>root},navigator:{},Auth:{user:{id:8}},setTimeout,clearTimeout,AbortController,console};
 const source=fs.readFileSync(require.resolve('../public/driver.js'),'utf8').replace(/\}\)\(\);\s*$/,
  "prepareGps=()=>{};loadChecklist=async()=>{};window.testSequence={renderDetail,deliveryStage,endSession:()=>sessionVersion++,endView:()=>viewVersion++,stopGps,gpsEligible};})();");
 vm.runInNewContext(source,sandbox);
 return {calls,detail,api:sandbox.window.testSequence,finish:()=>finish()};
}
test('mount de salida espera workflow y permite servicio completado',async()=>{
 const s=surface(),pending=s.api.renderDetail({id:7,status:'Completado'},[]);
 assert.deepEqual(s.calls,['workflow']);s.finish();await pending;
 assert.deepEqual(s.calls,['workflow','outing']);assert.equal(s.api.gpsEligible({truck_id:3,status:'Completado'}),false);
});
test('cambio de sesión, navegación o detalle desconectado impiden mount tardío',async()=>{
 for(const invalidate of [s=>s.api.endSession(),s=>s.api.endView(),s=>s.detail.isConnected=false]){
  const s=surface(),pending=s.api.renderDetail({id:7,status:'Completado'},[]);invalidate(s);s.finish();await pending;
  assert.equal(s.calls.includes('outing'),false);
 }
});
test('detener GPS detiene también el seguimiento de retorno',()=>{
 const s=surface();s.api.stopGps();assert.equal(s.calls.includes('pause'),true);
});

test('POD presenta etapa pendiente hasta llegada, recogida y descarga',()=>{
 const {api}=surface();
 assert.equal(api.deliveryStage({status:'En tránsito',version:0},9),'Pendiente llegada');
 assert.equal(api.deliveryStage({status:'Llegó a destino',version:0},9),'Pendiente descarga');
 assert.equal(api.deliveryStage({status:'Descargando',version:0},9),null);
 const context={version:1,status:'Descargando',next_stop:{key:'b'},loads:[{id:9,delivery:'b',picked_up:true}]};
 assert.equal(api.deliveryStage(context,9),'Pendiente llegada');context.next_stop.actual_arrival='2026-01-01';
 context.loads[0].picked_up=false;assert.equal(api.deliveryStage(context,9),'Pendiente recogida');
 context.loads[0].picked_up=true;assert.equal(api.deliveryStage(context,9),null);
 context.next_stop.key='c';assert.equal(api.deliveryStage(context,9),'Pendiente parada de entrega');
});
