// Read-only company administration surface. Contract and license mutations stay
// in platform administration; no company_id from query/body is authoritative.
function registerCompanyProfileRoutes(app,pool,{protectedUserRoutes,resolveActorContext}){
  app.get('/api/company/profile',...protectedUserRoutes,async(req,res)=>{
    const actor=resolveActorContext(req);
    const companyActor=actor?.actor_type==='company'&&actor.membership_id;
    const legacyAdmin=actor?.actor_type==='legacy'&&actor.role==='admin';
    if(actor?.scope!=='company'||!actor.company_id||(!companyActor&&!legacyAdmin))return res.status(403).json({error:'Se requiere administración de una empresa identificada'});
    try{
      const row=(await pool.query(`select c.id,c.legal_name,c.rut,c.trade_name,c.email,c.phone,c.address,c.commune,c.region,c.active,
        c.plan_code,c.license_status,c.license_started_at,c.license_expires_at,c.capabilities,c.user_limit,c.truck_limit,
        (select count(distinct um.user_id)::int from user_memberships um where um.company_id=c.id) registered_users,
        (select count(distinct um.user_id)::int from user_memberships um join users u on u.id=um.user_id where um.company_id=c.id and um.active=true and u.active=true) active_users,
        (select count(*)::int from trucks t where t.company_id=c.id) trucks
        from companies c where c.id=$1`,[actor.company_id])).rows[0];
      if(!row)return res.status(404).json({error:'Empresa no encontrada'});
      res.json({
        company:{id:row.id,legal_name:row.legal_name,rut:row.rut,trade_name:row.trade_name,email:row.email,phone:row.phone,address:row.address,commune:row.commune,region:row.region,active:row.active},
        license:{plan_code:row.plan_code,status:row.license_status,started_at:row.license_started_at,expires_at:row.license_expires_at,capabilities:row.capabilities,user_limit:row.user_limit,truck_limit:row.truck_limit},
        usage:{registered_users:row.registered_users,active_users:row.active_users,trucks:row.trucks}
      });
    }catch{res.status(500).json({error:'No se pudieron consultar los datos de empresa y licencia'})}
  });
}
module.exports={registerCompanyProfileRoutes};
