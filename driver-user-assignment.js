const {writeAudit}=require('./audit');

function registerDriverUserAssignmentRoutes(app,pool,{protectedUserRoutes,resolveActorContext,userView}){
  const endpoint='/api/users/:id/driver-assignment';
  const error=(status,message)=>Object.assign(new Error(message),{status});
  async function targetUser(db,req){
    const context=resolveActorContext(req);
    if(!context||context.actor_type==='unresolved')throw error(403,'Contexto empresarial requerido');
    const global=context.scope==='platform'||(context.actor_type==='legacy'&&context.role==='admin');
    if(!global&&!context.company_id)throw error(403,'Contexto empresarial requerido');
    const locked=(await db.query(`select u.id from users u where u.id=$1 and ($2::boolean=true or u.company_id=$3
      or exists(select 1 from user_memberships um where um.user_id=u.id and um.company_id=$3 and um.active=true)) for update of u`,[req.params.id,global,context.company_id||null])).rows[0];
    if(!locked)throw error(404,'Usuario no encontrado');
    const user=await userView(db,locked.id);
    if(!user)throw error(404,'Usuario activo no encontrado');
    if(!global&&user.company_id!==context.company_id)throw error(404,'Usuario no encontrado');
    if(user.role_code!=='driver'||!['company','legacy'].includes(user.actor_type)||!user.company_id){
      throw error(409,'El usuario debe tener un único contexto de empresa y rol conductor activo');
    }
    // El trigger 019 también exige consistencia con la empresa de la identidad original.
    if(user.legacy_company_id!==user.company_id)throw error(409,'La empresa de la cuenta y su membership requieren revisión antes de asociar un conductor');
    return {id:user.id,name:user.name,email:user.email,company_id:user.company_id,driver_id:user.driver_id||null};
  }
  function handler(update){return async(req,res)=>{
    const userId=Number(req.params.id);
    const driverId=req.body?.driver_id;
    if(!Number.isSafeInteger(userId)||userId<1)return res.status(400).json({error:'Usuario no válido'});
    if(update&&(!Number.isSafeInteger(driverId)||driverId<1))return res.status(400).json({error:'Selecciona un conductor válido'});
    let db;
    try{
      db=await pool.connect();
      await db.query('BEGIN');
      const before=await targetUser(db,req);
      if(!update){
        const drivers=(await db.query(`select d.id,d.name,d.rut,d.status from drivers d where d.company_id=$1
          and (d.status='Activo' or d.id=$2) and not exists(select 1 from users u where u.driver_id=d.id and u.id<>$3)
          order by d.name,d.id`,[before.company_id,before.driver_id,before.id])).rows;
        await db.query('COMMIT');
        return res.json({user:before,drivers});
      }
      const driver=(await db.query('select id,name,company_id,status from drivers where id=$1 and company_id=$2 for update',[driverId,before.company_id])).rows[0];
      if(!driver)throw error(404,'Conductor no encontrado en la empresa del usuario');
      if(driver.status!=='Activo')throw error(409,'El conductor debe estar activo');
      const occupied=(await db.query('select id from users where driver_id=$1 and id<>$2',[driver.id,before.id])).rows[0];
      if(occupied)throw error(409,'Este conductor ya está asociado a otro usuario');
      // No transferir una identidad ya vinculada: requiere un proceso separado y explícito.
      if(before.driver_id&&before.driver_id!==driver.id)throw error(409,'El usuario ya tiene otro conductor asociado; solicita revisión antes de cambiarlo');
      const after={...before,driver_id:driver.id};
      if(before.driver_id!==driver.id){
        const updated=await db.query('update users set driver_id=$1,updated_at=now() where id=$2 returning id',[driver.id,before.id]);
        if(!updated.rowCount)throw error(409,'No se pudo asociar el conductor');
        await writeAudit(db,req,{companyId:before.company_id,action:'driver_assignment',entity:'user',entityId:before.id,beforeData:before,afterData:after});
      }
      await db.query('COMMIT');
      res.json({user:after,driver:{id:driver.id,name:driver.name}});
    }catch(e){
      if(db)try{await db.query('ROLLBACK')}catch{}
      res.status(e.status||(e.code==='23505'?409:500)).json({error:e.status?e.message:e.code==='23505'?'Este conductor ya está asociado a otro usuario':'No se pudo guardar o consultar la asociación del conductor'});
    }finally{if(db)db.release()}
  }}
  app.get(endpoint,...protectedUserRoutes,handler(false));
  app.patch(endpoint,...protectedUserRoutes,handler(true));
}

module.exports={registerDriverUserAssignmentRoutes};
