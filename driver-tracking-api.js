'use strict';
const crypto=require('node:crypto'),D=require('./driver-tracking-domain');
const {assertPredeparture}=require('./trip-predeparture');
const {loadEligibility}=require('./personnel-access');
const {writeAudit}=require('./audit');

// Principal registers this AFTER authMiddleware and injects the existing driver guards.
function registerDriverTracking(app,pool,{driverAccess,enforceDriverPersonnel}={}){
 if(typeof driverAccess!=='function'||typeof enforceDriverPersonnel!=='function')throw Error('Driver tracking requires existing driver guards');
 const base='/api/driver/trips/:id/tracking';
 async function route(req,res,kind){
  if(!req.user)return res.status(401).json({error:'Autenticación requerida'});
  if(!driverAccess(req,res))return;
  let db;
  try{
   if(!/^[1-9]\d*$/.test(String(req.params.id)))throw D.fail(400,'INVALID_TRIP','Viaje no válido');
   const raw=req.get('authorization')||'';
   if(!raw.startsWith('Bearer ')||!raw.slice(7))throw D.fail(401,'AUTH_REQUIRED','Sesión Bearer requerida');
   const tokenHash=D.hash(raw.slice(7)),b=req.body||{};
   db=await pool.connect();await db.query('BEGIN');
   const auth=(await db.query('select * from user_sessions where user_id=$1 and token_hash=$2 and expires_at>now() for share',[req.user.id,tokenHash])).rows[0];
   if(!auth)throw D.fail(401,'AUTH_EXPIRED','Sesión vencida o revocada');
   if(!await enforceDriverPersonnel(db,req,res))return;
   const eligibility=await loadEligibility(db,{companyId:req.user.company_id,userId:req.user.id,lock:true});
   if(!eligibility.allowed)throw D.fail(403,'PERSONNEL_ACCESS_BLOCKED','Acceso laboral no vigente');
   const actor=(await db.query('select id from users where id=$1 and driver_id=$2 and active=true for share',[req.user.id,req.user.driver_id])).rows[0];
   if(!actor)throw D.fail(403,'DRIVER_CHANGED','La asociación de conductor cambió');
   // The trip lock serializes start retries. NOWAIT on outings avoids dispatcher lock cycles.
   const trip=(await db.query('select * from trips where id=$1 and company_id=$2 for update',[req.params.id,req.user.company_id])).rows[0];
   if(!trip)throw D.fail(404,'TRIP_NOT_FOUND','Viaje no disponible');
   const requested=kind==='context'?req.query?.tracking_session_id:b.tracking_session_id;
   if(requested!==undefined&&!D.uuid(requested))throw D.fail(400,'INVALID_SESSION','Sesión GPS no válida');
   let session=(await db.query(`select * from driver_tracking_sessions where trip_id=$1 and company_id=$2 and user_id=$3 and auth_session_id=$4
    ${requested?'and id=$5':'order by created_at desc,id desc limit 1'} for update`,[trip.id,req.user.company_id,req.user.id,auth.id,...(requested?[requested]:[])])).rows[0];
   if(['positions','stop'].includes(kind)&&!requested)throw D.fail(400,'SESSION_REQUIRED','Indica la sesión GPS');
   if(requested&&!session)throw D.fail(404,'SESSION_NOT_FOUND','Sesión GPS no disponible');
   // Explicit starts may create a fresh UUID after stop/review; GET never revives it.
   if(kind==='start'&&!requested&&session?.closed_at)session=null;
   if(!session&&!D.same(trip.driver_id,req.user.driver_id))throw D.fail(404,'TRIP_NOT_FOUND','Viaje no disponible');
   const outing=(await db.query(`select o.* from operational_outings o join operational_outing_services s on s.outing_id=o.id and s.company_id=o.company_id
    where s.company_id=$1 and s.trip_id=$2 for update of o nowait`,[trip.company_id,trip.id])).rows[0];
   const latest=outing?(await db.query(`select t.* from operational_outing_services s join trips t on t.id=s.trip_id and t.company_id=s.company_id
    where s.company_id=$1 and s.outing_id=$2 order by s.sequence desc limit 1`,[trip.company_id,outing.id])).rows[0]:null;
   if(kind==='start'&&!session){
    const interval=b.interval_seconds??30;
    if(!Number.isInteger(interval)||interval<15||interval>300)throw D.fail(400,'INVALID_INTERVAL','Intervalo permitido: 15 a 300 segundos');
    await assertPredeparture(db,{companyId:trip.company_id,tripId:trip.id,truckId:trip.truck_id,driverId:trip.driver_id});
    const candidate={...trip,trip_id:trip.id,outing_id:outing?.id,closed_at:null};
    if(D.phase(candidate,trip,outing,latest).state==='closed')throw D.fail(409,'TRACKING_NOT_READY','Este servicio no permite iniciar GPS');
    session=(await db.query(`insert into driver_tracking_sessions(id,company_id,user_id,auth_session_id,token_hash,trip_id,driver_id,truck_id,resource_version,itinerary_version,outing_id,expires_at,interval_seconds,last_state)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,[crypto.randomUUID(),trip.company_id,req.user.id,auth.id,tokenHash,trip.id,trip.driver_id,trip.truck_id,trip.resource_version,trip.itinerary_version,outing?.id||null,auth.expires_at,interval,D.phase(candidate,trip,outing,latest).state])).rows[0];
    await writeAudit(db,req,{companyId:trip.company_id,action:'driver_tracking_start',entity:'driver_tracking_session',entityId:session.id,afterData:{trip_id:trip.id,truck_id:trip.truck_id,driver_id:trip.driver_id}});
   }
   if(!session)throw D.fail(409,'TRACKING_SESSION_REQUIRED','Autoriza e inicia el seguimiento GPS');
   let phase=D.phase(session,trip,outing,latest);
   if(!D.same(session.driver_id,req.user.driver_id))phase={state:'closed',review_required:true,reason:'DRIVER_CHANGED'};
   if(kind==='stop')phase={state:'closed',review_required:false,reason:'USER_STOP'};
   // An outing created after start can be pinned once, only for the same identity.
   if(!session.outing_id&&outing&&!session.closed_at){
    if(D.same(outing.truck_id,session.truck_id)&&D.same(outing.driver_id,session.driver_id)){
     session.outing_id=outing.id;await db.query('update driver_tracking_sessions set outing_id=$2 where id=$1',[session.id,outing.id]);
    }else phase={state:'closed',review_required:true,reason:'OUTING_RESOURCE_CHANGED'};
   }
   if(phase.state==='closed'&&!session.closed_at){
    await db.query('update driver_tracking_sessions set closed_at=now(),review_required=$2,close_reason=$3 where id=$1',[session.id,phase.review_required,phase.reason]);
    await writeAudit(db,req,{companyId:trip.company_id,action:'driver_tracking_stop',entity:'driver_tracking_session',entityId:session.id,afterData:{reason:phase.reason,review_required:phase.review_required}});
   }
   if(phase.state!=='closed'){
    const snapshot=phase.state==='active'?trip.commercial_modules:outing?.commercial_modules;
    if(snapshot!=null){if(!snapshot.includes('gps'))throw D.fail(403,'GPS_NOT_CONTRACTED','GPS no contratado para este servicio o salida');}
    else await db.query("select commercial_require($1,'gps',$2)",[session.company_id,session.truck_id]);
    if(phase.state==='active')await assertPredeparture(db,{companyId:trip.company_id,tripId:trip.id,truckId:trip.truck_id,driverId:trip.driver_id});
   }
   if(session.last_state!==phase.state){
    const observed=(await db.query('update driver_tracking_sessions set last_state=$2,phase_since=clock_timestamp() where id=$1 returning phase_since',[session.id,phase.state])).rows[0];
    session.phase_since=observed.phase_since;
   }
   const context={tracking_session_id:session.id,user_id:session.user_id,trip_id:session.trip_id,company_id:session.company_id,driver_id:session.driver_id,truck_id:session.truck_id,resource_version:session.resource_version,itinerary_version:session.itinerary_version,outing_id:session.outing_id||null,...phase,started_at:session.created_at,session_started_at:session.created_at,phase_since:session.phase_since,interval_seconds:session.interval_seconds,max_batch_size:50,max_offline_seconds:86400,expires_at:session.expires_at};
   let accepted_ids;
   if(kind==='positions'){
    accepted_ids=[];
    for(const p of D.positions(b,session)){
     const prior=(await db.query('select payload_hash from driver_tracking_positions where tracking_session_id=$1 and client_position_id=$2',[session.id,p.client_position_id])).rows[0];
     if(prior){if(prior.payload_hash!==p.payload_hash)throw D.fail(409,'POSITION_ID_CONFLICT','El identificador GPS ya corresponde a otros datos');}
     else{
      if(phase.state==='closed')throw D.fail(409,'TRACKING_CLOSED','La sesión GPS está cerrada; revisa su contexto');
      if(p.state!==phase.state||Date.parse(p.captured_at)<new Date(session.phase_since).getTime())throw D.fail(409,'POSITION_PHASE_REVIEW','No se puede verificar la fase histórica de esta posición; conserva el pendiente para revisión');
      const id=(await db.query('insert into telemetry(truck_id,trip_id,outing_id,lat,lng,speed_kmh,recorded_at) values($1,$2,$3,$4,$5,$6,$7) returning id',[session.truck_id,phase.state==='active'?session.trip_id:null,phase.state==='active'?null:session.outing_id,p.lat,p.lng,p.speed_kmh,p.captured_at])).rows[0].id;
      await db.query('insert into driver_tracking_positions(company_id,tracking_session_id,client_position_id,payload_hash,telemetry_id,captured_at,accuracy_m,state) values($1,$2,$3,$4,$5,$6,$7,$8)',[session.company_id,session.id,p.client_position_id,p.payload_hash,id,p.captured_at,p.accuracy_m,p.state]);
     }
     if(!accepted_ids.includes(p.client_position_id))accepted_ids.push(p.client_position_id);
    }
   }
   await db.query('COMMIT');res.json(accepted_ids?{accepted_ids,context}:context);
  }catch(e){if(db)try{await db.query('ROLLBACK');}catch{}res.status(e.status||(/^P75/.test(e.code||'')?403:503)).json({code:e.code||'TRACKING_UNAVAILABLE',error:e.status?e.message:'No se confirmó el seguimiento GPS; conserva los pendientes'});}finally{db?.release();}
 }
 app.post(base,(req,res)=>route(req,res,'start'));
 app.get(base+'/context',(req,res)=>route(req,res,'context'));
 app.post(base+'/positions',(req,res)=>route(req,res,'positions'));
 app.post(base+'/stop',(req,res)=>route(req,res,'stop'));
}
module.exports={registerDriverTracking};
