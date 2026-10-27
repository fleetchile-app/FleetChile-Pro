const {writeAudit}=require('./audit');
const {terminal}=require('./trip-resources');

function registerTripLoadTransfer(app,pool,{requirePermission,tripScope}){
  app.post('/api/operations/trips/:id/loads/:loadId/transfer',requirePermission('loads.manage'),async(req,res)=>{
    const sourceId=Number(req.params.id),loadId=Number(req.params.loadId),targetId=req.body?.target_trip_id;
    const reason=typeof req.body?.reason==='string'?req.body.reason.trim():'';
    if(![sourceId,loadId,targetId].every(id=>Number.isSafeInteger(id)&&id>0)||sourceId===targetId)return res.status(400).json({error:'Selecciona una carga y un viaje de destino distinto'});
    if(!reason||reason.length>2000)return res.status(400).json({error:'Indica el motivo de la reasignación (máximo 2000 caracteres)'});
    let db;
    try{
      db=await pool.connect();await db.query('BEGIN');
      const scope=tripScope(req,'t',2);
      const source=(await db.query(`select id,company_id from trips t where t.id=$1 and ${scope.sql}`,[sourceId,...scope.values])).rows[0];
      if(!source){await db.query('ROLLBACK');return res.sendStatus(404)}
      // Orden estable para que dos transferencias cruzadas no bloqueen los viajes en distinto orden.
      const trips=(await db.query('select * from trips where id=any($1::bigint[]) and company_id=$2 order by id for update',[[sourceId,targetId],source.company_id])).rows;
      const from=trips.find(trip=>String(trip.id)===String(sourceId)),to=trips.find(trip=>String(trip.id)===String(targetId));
      if(!from||!to){await db.query('ROLLBACK');return res.sendStatus(404)}
      if(terminal(from.status)||terminal(to.status)){await db.query('ROLLBACK');return res.status(409).json({error:'No se pueden transferir cargas desde o hacia viajes completados o cancelados'})}
      const load=(await db.query('select * from trip_loads where id=$1 and trip_id=$2 for update',[loadId,from.id])).rows[0];
      if(!load){await db.query('ROLLBACK');return res.sendStatus(404)}
      if(load.status==='Entregada'||load.delivered_at){await db.query('ROLLBACK');return res.status(409).json({error:'Una carga entregada no puede reasignarse'})}
      const proof=(await db.query('select id from trip_delivery_proofs where load_id=$1 limit 1',[load.id])).rows[0];
      if(proof){await db.query('ROLLBACK');return res.status(409).json({error:'La carga tiene un POD o borrador asociado y requiere revisión antes de transferirse'})}
      const updated=(await db.query('update trip_loads set trip_id=$1 where id=$2 and trip_id=$3 returning *',[to.id,load.id,from.id])).rows[0];
      if(!updated)throw new Error('No se pudo transferir la carga bloqueada');
      await require('./itinerary-api').transferredLoad(db,req,from,load.id,reason);
      const details={load_id:load.id,source_trip_id:from.id,target_trip_id:to.id,reason};
      for(const trip of [from,to])await db.query('insert into trip_events(trip_id,event_type,notes,created_by,details) values($1,$2,$3,$4,$5)',[trip.id,'Reasignación de carga',reason,req.user.id,details]);
      await writeAudit(db,req,{companyId:source.company_id,action:'transfer',entity:'trip_load',entityId:load.id,beforeData:load,afterData:{...updated,transfer:details}});
      await db.query('COMMIT');res.json({load:updated,transfer:details});
    }catch(error){
      if(db)try{await db.query('ROLLBACK')}catch{}
      res.status(500).json({error:'No se pudo reasignar la carga; no se confirmó la transferencia'});
    }finally{if(db)db.release()}
  });
}
module.exports={registerTripLoadTransfer};
