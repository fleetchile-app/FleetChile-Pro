const {requirePermission}=require('./auth');
const {writeAudit}=require('./audit');

const isAdmin=req=>req.user?.role_code==='admin';
const explicitCompanyId=req=>{
  const raw=req.body?.company_id??req.query?.company_id;
  if(raw===undefined||raw===null||raw==='')return null;
  const value=Number(raw);
  return Number.isInteger(value)&&value>0?value:null;
};
const scopedCompanyId=req=>isAdmin(req)?explicitCompanyId(req):req.user?.company_id;
const revenueStatus=(defined,value,legacy)=>legacy?'legacy_unverified':!defined?'not_informed':Number(value)===0?'confirmed_zero':'confirmed_positive';
const economicView=(trip,profile)=>{
  const legacy=!profile;
  const defined=profile?.revenue_defined===true;
  return {
    trip_id:trip.id,
    company_id:trip.company_id,
    revenue_clp:trip.revenue_clp===null?null:Number(trip.revenue_clp),
    revenue_defined:defined,
    revenue_status:revenueStatus(defined,trip.revenue_clp,legacy),
    revenue_includes_vat:profile?.revenue_includes_vat??null,
    revenue_confirmed_by:profile?.revenue_confirmed_by??null,
    revenue_confirmed_at:profile?.revenue_confirmed_at??null,
    economic_status:profile?.economic_status??null,
    actual_departure:trip.actual_departure??null,
    trip_status:trip.status,
    legacy_unverified:legacy
  };
};

function registerEconomicsRoutes(app,pool){
  app.get('/api/economics/trips/:id',requirePermission('economics.read'),async(req,res)=>{
    const cid=scopedCompanyId(req);
    if(!cid)return res.status(400).json({error:'company_id es obligatorio para consultar este recurso'});
    try{
      const result=await pool.query(
        `select t.id,t.company_id,t.revenue_clp,t.actual_departure,t.status,
                ep.revenue_defined,ep.revenue_includes_vat,ep.revenue_confirmed_by,
                ep.revenue_confirmed_at,ep.economic_status,ep.trip_id as economic_profile_trip_id
           from trips t
           left join trip_economic_profiles ep on ep.trip_id=t.id and ep.company_id=t.company_id
          where t.id=$1 and t.company_id=$2`,
        [req.params.id,cid]
      );
      if(!result.rowCount)return res.sendStatus(404);
      const row=result.rows[0];
      const profile=row.economic_profile_trip_id?row:null;
      res.json(economicView(row,profile));
    }catch{
      res.status(500).json({error:'No se pudo consultar la información económica del viaje'});
    }
  });

  app.get('/api/economics/trips/:id/revenue-history',requirePermission('economics.read'),async(req,res)=>{
    const cid=scopedCompanyId(req);
    if(!cid)return res.status(400).json({error:'company_id es obligatorio para consultar este recurso'});
    try{
      const trip=await pool.query('select id from trips where id=$1 and company_id=$2',[req.params.id,cid]);
      if(!trip.rowCount)return res.sendStatus(404);
      const history=await pool.query(
        `select h.id,h.company_id,h.trip_id,h.previous_revenue_clp,h.new_revenue_clp,
                h.revenue_defined,h.includes_vat,h.zero_justification,h.change_reason,
                h.authorization_request_id,h.created_by,h.created_at,u.name as created_by_name
           from trip_revenue_history h
           left join users u on u.id=h.created_by
          where h.trip_id=$1 and h.company_id=$2
          order by h.created_at desc,h.id desc`,
        [req.params.id,cid]
      );
      res.json(history.rows);
    }catch{
      res.status(500).json({error:'No se pudo consultar el historial de ingresos'});
    }
  });

  app.patch('/api/economics/trips/:id/revenue',requirePermission('economics.manage'),async(req,res)=>{
    const cid=scopedCompanyId(req);
    if(!cid)return res.status(400).json({error:'company_id es obligatorio para modificar este recurso'});
    const raw=req.body?.revenue_clp;
    if(raw===undefined||raw===null||(typeof raw==='string'&&raw.trim()==='')||typeof raw==='boolean'||Array.isArray(raw)||typeof raw==='object')return res.status(400).json({error:'revenue_clp es obligatorio y debe ser un entero no negativo'});
    const revenue=Number(raw);
    if(!Number.isSafeInteger(revenue)||revenue<0)return res.status(400).json({error:'revenue_clp es obligatorio y debe ser un entero no negativo'});
    const vat=req.body?.revenue_includes_vat;
    if(vat!==undefined&&vat!==null&&typeof vat!=='boolean')return res.status(400).json({error:'revenue_includes_vat debe ser boolean o null'});
    const includesVat=vat??null;
    const reason=typeof req.body?.reason==='string'?req.body.reason.trim():'';
    if(revenue===0&&!reason)return res.status(400).json({error:'La justificación es obligatoria para confirmar un ingreso cero'});

    let db=null;
    let transactionOpen=false;
    try{
      db=await pool.connect();
      await db.query('BEGIN');transactionOpen=true;
      const tripResult=await db.query('select id,company_id,revenue_clp,actual_departure,status from trips where id=$1 and company_id=$2 for update',[req.params.id,cid]);
      if(!tripResult.rowCount){await db.query('ROLLBACK');transactionOpen=false;return res.sendStatus(404)}
      const trip=tripResult.rows[0];
      if(trip.actual_departure!==null&&trip.actual_departure!==undefined){
        await db.query('ROLLBACK');transactionOpen=false;
        return res.status(409).json({error:'La modificación del ingreso requiere autorización porque el viaje ya fue iniciado',code:'ECONOMIC_AUTHORIZATION_REQUIRED'});
      }
      const profileResult=await db.query('select * from trip_economic_profiles where trip_id=$1 and company_id=$2 for update',[trip.id,cid]);
      const previousProfile=profileResult.rows[0]||null;
      const before=economicView(trip,previousProfile);
      const profile=(await db.query(
        `insert into trip_economic_profiles(trip_id,company_id,revenue_defined,revenue_includes_vat,revenue_confirmed_by,revenue_confirmed_at,economic_status,updated_at)
         values($1,$2,true,$3,$4,now(),'open',now())
         on conflict(trip_id) do update set company_id=excluded.company_id,revenue_defined=true,
           revenue_includes_vat=excluded.revenue_includes_vat,revenue_confirmed_by=excluded.revenue_confirmed_by,
           revenue_confirmed_at=excluded.revenue_confirmed_at,updated_at=now()
         returning *`,
        [trip.id,cid,includesVat,req.user.id]
      )).rows[0];
      await db.query(
        `insert into trip_revenue_history(company_id,trip_id,previous_revenue_clp,new_revenue_clp,revenue_defined,
          includes_vat,zero_justification,change_reason,authorization_request_id,created_by)
         values($1,$2,$3,$4,true,$5,$6,$7,null,$8)`,
        [cid,trip.id,trip.revenue_clp,revenue,includesVat,revenue===0?reason:null,reason||null,req.user.id]
      );
      await db.query('update trips set revenue_clp=$1,updated_at=now() where id=$2 and company_id=$3',[revenue,trip.id,cid]);
      const after=economicView({...trip,revenue_clp:revenue},profile);
      await writeAudit(db,req,{companyId:cid,action:previousProfile?.revenue_defined===true?'update':'define',entity:'trip_revenue',entityId:trip.id,beforeData:before,afterData:{...after,reason:reason||null}});
      await db.query('COMMIT');transactionOpen=false;
      res.json(after);
    }catch{
      if(transactionOpen){try{await db.query('ROLLBACK')}catch{}}
      res.status(500).json({error:'No se pudo modificar el ingreso del viaje'});
    }finally{
      if(db)db.release();
    }
  });
}

module.exports={registerEconomicsRoutes,economicView};
