const {requirePermission}=require('./auth');
const {writeAudit}=require('./audit');

const rolePermissions=async(db,roleId)=>(await db.query('select p.id,p.code,p.name,p.module from permissions p join role_permissions rp on rp.permission_id=p.id where rp.role_id=$1 order by p.module,p.code',[roleId])).rows;
const companyView=async(db,id,forUpdate=false)=>(await db.query(`select id,legal_name,rut,trade_name,email,phone,address,commune,region,active,created_at,updated_at from companies where id=$1${forUpdate?' for update':''}`,[id])).rows[0]||null;
const settingView=async(db,key,forUpdate=false)=>(await db.query(`select id,setting_key,category,label,value,description,updated_at,updated_by from system_settings where setting_key=$1${forUpdate?' for update':''}`,[key])).rows[0]||null;

function registerAdminRoutes(app,pool){
  app.get('/api/public/settings',async(req,res)=>{try{const r=await pool.query("select setting_key,value from system_settings where setting_key in ('appearance.company_name','appearance.language')");const out={};for(const x of r.rows)out[x.setting_key]=x.value;res.json(out)}catch(e){res.status(500).json({error:'No se pudo cargar la configuración pública'})}});
  const adminOnly=(req,res,next)=>{if(req.user?.role_code==='admin')return next();res.status(403).json({error:'Acceso restringido a administradores'});};

  app.get('/api/admin/settings',adminOnly,async(req,res)=>{try{const r=await pool.query('select setting_key,category,label,value,description,updated_at from system_settings order by category,setting_key');res.json(r.rows)}catch(e){res.status(500).json({error:'No se pudieron consultar las configuraciones'})}});
  app.patch('/api/admin/settings/:key',adminOnly,async(req,res)=>{const value=req.body?.value;if(value===undefined)return res.status(400).json({error:'El valor es obligatorio'});const client=await pool.connect();try{await client.query('BEGIN');const before=await settingView(client,req.params.key,true);if(!before){await client.query('ROLLBACK');return res.status(404).json({error:'Configuración no encontrada'})}const r=await client.query('update system_settings set value=$1::jsonb,updated_at=now(),updated_by=$2 where setting_key=$3 returning setting_key',[JSON.stringify(value),req.user.id,req.params.key]);if(!r.rowCount)throw new Error('No se pudo actualizar la configuración bloqueada');const after=await settingView(client,r.rows[0].setting_key);if(!after)throw new Error('No se pudo obtener la configuración actualizada');await writeAudit(client,req,{companyId:null,action:'update',entity:'system_setting',entityId:after.setting_key,beforeData:before,afterData:after});await client.query('COMMIT');res.json(after)}catch(e){await client.query('ROLLBACK');res.status(400).json({error:'No se pudo guardar la configuración'})}finally{client.release()}});

  app.get('/api/admin/permissions',adminOnly,async(req,res)=>{try{const r=await pool.query(`select p.id,p.code,p.name,p.module,coalesce(json_agg(json_build_object('role_id',rp.role_id,'role_code',r.code)) filter(where r.id is not null),'[]') roles from permissions p left join role_permissions rp on rp.permission_id=p.id left join roles r on r.id=rp.role_id group by p.id order by p.module,p.code`);res.json(r.rows)}catch(e){res.status(500).json({error:'No se pudieron consultar los permisos'})}});
  app.get('/api/admin/roles/:id/permissions',adminOnly,async(req,res)=>{try{const r=await pool.query('select p.id,p.code,p.name,p.module from permissions p join role_permissions rp on rp.permission_id=p.id where rp.role_id=$1 order by p.module,p.code',[req.params.id]);res.json(r.rows)}catch(e){res.status(500).json({error:'No se pudieron consultar los permisos del rol'})}});
  app.put('/api/admin/roles/:id/permissions',adminOnly,async(req,res)=>{
    const ids=Array.isArray(req.body?.permission_ids)?req.body.permission_ids:[];
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const role=(await client.query('select id,code,name from roles where id=$1 for update',[req.params.id])).rows[0];
      if(!role){await client.query('ROLLBACK');return res.sendStatus(404);}
      const beforePermissions=await rolePermissions(client,role.id);
      await client.query('delete from role_permissions where role_id=$1',[role.id]);
      for(const id of ids)await client.query('insert into role_permissions(role_id,permission_id) values($1,$2) on conflict do nothing',[role.id,id]);
      const afterPermissions=await rolePermissions(client,role.id);
      const roleData={role_id:role.id,role_code:role.code,role_name:role.name};
      await writeAudit(client,req,{companyId:null,action:'update',entity:'role_permissions',entityId:role.id,beforeData:{...roleData,permissions:beforePermissions},afterData:{...roleData,permissions:afterPermissions}});
      await client.query('COMMIT');
      res.json({ok:true});
    } catch(e){
      await client.query('ROLLBACK');
      res.status(500).json({error:'No se pudieron guardar los permisos'});
    } finally {client.release();}
  });

  app.patch('/api/admin/companies/:id',adminOnly,async(req,res)=>{const b=req.body||{};const fields=[];const vals=[];const add=(f,v)=>{fields.push(`${f}=$${vals.length+1}`);vals.push(v)};['legal_name','rut','trade_name','email','phone','address','commune','region'].forEach(k=>{if(b[k]!==undefined)add(k,b[k]||null)});if(b.active!==undefined)add('active',!!b.active);if(!fields.length)return res.status(400).json({error:'No hay cambios'});const client=await pool.connect();try{await client.query('BEGIN');const before=await companyView(client,req.params.id,true);if(!before){await client.query('ROLLBACK');return res.sendStatus(404)}vals.push(req.params.id);const r=await client.query(`update companies set ${fields.join(',')},updated_at=now() where id=$${vals.length} returning id`,vals);if(!r.rowCount)throw new Error('No se pudo actualizar la empresa bloqueada');const after=await companyView(client,r.rows[0].id);if(!after)throw new Error('No se pudo obtener la empresa actualizada');await writeAudit(client,req,{companyId:after.id,action:'update',entity:'company',entityId:after.id,beforeData:before,afterData:after});await client.query('COMMIT');res.json(after)}catch(e){await client.query('ROLLBACK');res.status(400).json({error:'No se pudo actualizar la empresa'})}finally{client.release()}});

  app.get('/api/admin/audit',adminOnly,async(req,res)=>{try{const r=await pool.query(`select a.*,u.name user_name,c.legal_name company_name from audit_logs a left join users u on u.id=a.user_id left join companies c on c.id=a.company_id order by a.created_at desc limit 300`);res.json(r.rows)}catch(e){res.status(500).json({error:'No se pudo consultar la auditoría'})}});
}
module.exports={registerAdminRoutes};
