'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/driver-tracking.js'),'utf8');
function fixture({native=true,status}={}){
 const nodes=new Map(),timers=new Map(),calls=[],elements=[];
 const element=()=>({dataset:{},isConnected:true,disabled:false,checked:false,textContent:'',querySelector(s){if(!nodes.has(s))nodes.set(s,element());return nodes.get(s);}});
 const detail={host:null,querySelector(){return this.host;},append(e){this.host=e;elements.push(e);}};
 const trip={id:7,truck_id:3,resource_version:1,itinerary_version:2};
 const context={tracking_session_id:'session',user_id:1,company_id:2,driver_id:4,truck_id:3,trip_id:7,resource_version:1,itinerary_version:2,state:'active',expires_at:new Date(Date.now()+3600000).toISOString()};
 const currentStatus={running:false,signal:'waiting',pending:0,...status};
 const window={FleetNative:{backgroundGps:native},Auth:{token:'test-only-token',user:{id:1,company_id:2,driver_id:4},async request(url,options){calls.push(['request',url,options]);return {...context};}},FleetTracking:{async start(args){calls.push(['start',args]);currentStatus.running=true;},async stop(){calls.push(['stop']);currentStatus.running=false;},async status(){calls.push(['status']);return {...currentStatus};}}};
 let seq=0;
 const document={hidden:false,createElement:element};
 vm.runInNewContext(source,{window,document,AbortController,Date,setTimeout(fn,ms){const id=++seq;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},console});
 const ctx={ready:false,accepted_at:null,status:'En carga',resource_version:1,version:2};
 return {window,document,trip,ctx,context,detail,nodes,calls,timers,currentStatus,mount:()=>window.DriverTracking.mount(trip,detail,ctx)};
}
test('consentimiento previo a readiness; mount reutiliza host y no duplica start; nav/hidden no detiene',async()=>{
 const f=fixture();await f.mount();const host=f.detail.host;
 const consent=f.nodes.get('[data-tracking-consent]');consent.checked=true;consent.onchange();
 assert.equal(f.calls.filter(c=>c[0]==='request').length,0);
 f.ctx.ready=true;f.ctx.accepted_at=new Date().toISOString();await f.mount();
 assert.equal(f.calls.filter(c=>c[0]==='start').length,1);await f.mount();
 assert.equal(f.detail.host,host);assert.equal(f.calls.filter(c=>c[0]==='start').length,1);
 f.document.hidden=true;for(const timer of [...f.timers.values()])if(timer.ms===5000)await timer.fn();
 assert.equal(f.calls.filter(c=>c[0]==='stop').length,0);
 host.isConnected=false;for(const timer of [...f.timers.values()])if(timer.ms===5000)await timer.fn();
 assert.equal(f.calls.filter(c=>c[0]==='stop').length,0);
 await f.window.DriverTracking.stop();assert.equal(f.calls.filter(c=>c[0]==='stop').length,1);
 assert.ok(f.calls.some(c=>c[0]==='request'&&c[1].endsWith('/stop')));
});
test('reload adopta sesión nativa sólo tras verificar UUID con Bearer actual; no duplicate start',async()=>{
 const f=fixture();f.currentStatus.running=true;f.currentStatus.context=f.context;f.ctx.ready=true;f.ctx.accepted_at='yes';
 await f.mount();assert.equal(f.calls.filter(c=>c[0]==='start').length,0);
 assert.ok(f.calls.some(c=>c[0]==='request'&&c[1].includes('/context?tracking_session_id=')));
 assert.match(f.nodes.get('[data-tracking-status]').textContent,/GPS activo/);
});
test('cambio actor detiene sesión nativa y requiere nuevo consentimiento; web no anuncia background',async()=>{
 const f=fixture({status:{running:true,context:{user_id:99}}});await f.mount();assert.equal(f.calls.filter(c=>c[0]==='stop').length,1);assert.equal(f.calls.filter(c=>c[0]==='start').length,0);
 const web=fixture({native:false});await web.mount();assert.equal(web.nodes.get('[data-tracking-start]').disabled,true);assert.match(web.nodes.get('[data-tracking-description]').textContent,/no ofrece seguimiento/);
});
test('timeout aborta start y libera inflight para reintentar; no afirma activo antes del status real',async()=>{
 const f=fixture();await f.mount();f.ctx.ready=true;f.ctx.accepted_at='yes';
 f.window.Auth.request=async(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('timeout'))));
 const consent=f.nodes.get('[data-tracking-consent]');consent.checked=true;consent.onchange();
 const mount=f.mount();for(let i=0;i<8;i++)await Promise.resolve();
 for(const timer of [...f.timers.values()])if(timer.ms===15000)timer.fn();await mount;
 assert.equal(f.nodes.get('[data-tracking-start]').disabled,false);assert.equal(f.calls.filter(c=>c[0]==='start').length,0);
});
