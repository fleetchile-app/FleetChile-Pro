const crypto = require('crypto');
const {writeAudit} = require('./audit');

const clean = v => typeof v === 'string' ? v.trim() : v;
const hashPassword = password => new Promise((resolve,reject) => {
  const salt = crypto.randomBytes(16).toString('hex');
  crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err,key) => {
    if (err) return reject(err);
    resolve(`scrypt$${salt}$${key.toString('hex')}`);
  });
});
const verifyPassword = (password, stored) => new Promise(resolve => {
  try {
    const [scheme,salt,hex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !salt || !hex) return resolve(false);
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err,key) => {
      if (err) return resolve(false);
      const a = Buffer.from(hex,'hex'); const b = Buffer.from(key);
      resolve(a.length === b.length && crypto.timingSafeEqual(a,b));
    });
  } catch { resolve(false); }
});
const token = () => crypto.randomBytes(32).toString('hex');
const tokenHash = value => crypto.createHash('sha256').update(value).digest('hex');

async function userView(pool,userId){
  const r = await pool.query(`select u.id,u.name,u.email,u.phone,u.company_id,u.role_id,r.code role_code,r.name role_name,c.legal_name company_name,
    coalesce((select json_agg(p.code order by p.code) from role_permissions rp join permissions p on p.id=rp.permission_id where rp.role_id=u.role_id),'[]'::json) permissions
    from users u left join roles r on r.id=u.role_id left join companies c on c.id=u.company_id where u.id=$1 and u.active=true`,[userId]);
  return r.rows[0] || null;
}

async function userAuditView(db,userId){
  const r=await db.query(`select u.id,u.name,u.email,u.phone,u.active,u.last_login_at,u.company_id,u.role_id,u.created_at,u.updated_at,
    r.code role_code,r.name role_name,c.legal_name company_name
    from users u left join roles r on r.id=u.role_id left join companies c on c.id=u.company_id where u.id=$1`,[userId]);
  return r.rows[0] || null;
}

async function authenticateToken(pool,req){
  const h=req.get('authorization')||'';
  const raw=h.startsWith('Bearer ')?h.slice(7):'';
  if(!raw)return null;
  const r=await pool.query(`select s.user_id from user_sessions s where s.token_hash=$1 and s.expires_at>now()`,[tokenHash(raw)]);
  if(!r.rowCount)return null;
  const user=await userView(pool,r.rows[0].user_id);
  if(user) await pool.query('update user_sessions set last_seen_at=now() where token_hash=$1',[tokenHash(raw)]);
  return user;
}

function registerAuthRoutes(app,pool){
  app.get('/api/auth/status',async(req,res)=>{
    try { const r=await pool.query('select count(*)::int n from users'); res.json({setupRequired:r.rows[0].n===0}); }
    catch { res.status(500).json({error:'No se pudo consultar el estado de autenticación'}); }
  });

  app.post('/api/auth/setup',async(req,res)=>{
    const b=req.body||{};
    if(!clean(b.name)||!clean(b.email)||!clean(b.password)) return res.status(400).json({error:'Nombre, correo y contraseña son obligatorios'});
    if(String(b.password).length<10) return res.status(400).json({error:'La contraseña debe tener al menos 10 caracteres'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const count=await client.query('select count(*)::int n from users');
      if(count.rows[0].n!==0){await client.query('ROLLBACK');return res.status(409).json({error:'La configuración inicial ya fue realizada'});}
      const company=(await client.query('select id from companies where active=true order by id limit 1')).rows[0];
      const role=(await client.query("select id from roles where code='admin'")).rows[0];
      const password_hash=await hashPassword(String(b.password));
      const u=(await client.query('insert into users(company_id,role_id,name,email,password_hash,phone) values($1,$2,$3,$4,$5,$6) returning id',[company?.id||null,role.id,clean(b.name),clean(b.email).toLowerCase(),password_hash,clean(b.phone)||null])).rows[0];
      const user=await userView(client,u.id);
      if(!user) throw new Error('No se pudo obtener el administrador creado');
      await writeAudit(client,req,{companyId:company?.id||null,action:'create',entity:'user',entityId:u.id,afterData:user});
      await client.query('COMMIT');
      res.status(201).json({ok:true,user});
    } catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.code==='23505'?'El correo ya existe':'No se pudo crear el administrador'});} finally {client.release();}
  });

  app.post('/api/auth/login',async(req,res)=>{
    const email=clean(req.body?.email)?.toLowerCase(); const password=String(req.body?.password||'');
    if(!email||!password) return res.status(400).json({error:'Correo y contraseña son obligatorios'});
    try {
      const r=await pool.query('select id,password_hash from users where lower(email)=lower($1) and active=true',[email]);
      if(!r.rowCount || !(await verifyPassword(password,r.rows[0].password_hash))) return res.status(401).json({error:'Credenciales inválidas'});
      const raw=token();
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("insert into user_sessions(user_id,token_hash,expires_at,ip,user_agent) values($1,$2,now()+interval '12 hours',$3,$4)",[r.rows[0].id,tokenHash(raw),req.ip,req.get('user-agent')||null]);
        await client.query('update users set last_login_at=now() where id=$1',[r.rows[0].id]);
        const user=await userView(client,r.rows[0].id);
        if(!user) throw new Error('Usuario no disponible después de autenticar');
        await client.query('COMMIT');
        res.json({token:raw,user});
      } catch {
        await client.query('ROLLBACK');
        res.status(500).json({error:'No se pudo iniciar sesión'});
      } finally {client.release();}
    } catch { res.status(500).json({error:'No se pudo iniciar sesión'}); }
  });

  app.post('/api/auth/logout',async(req,res)=>{const h=req.get('authorization')||'';const raw=h.startsWith('Bearer ')?h.slice(7):'';if(raw) await pool.query('delete from user_sessions where token_hash=$1',[tokenHash(raw)]);res.json({ok:true});});

  app.get('/api/auth/me',async(req,res)=>{
    try { const user=await authenticateToken(pool,req); if(!user)return res.status(401).json({error:'No autenticado'}); res.json({user}); }
    catch { res.status(401).json({error:'No se pudo validar la sesión'}); }
  });

  const protectedUserRoutes = [authMiddleware.bind(null,pool), requirePermission('users.manage')];
  app.get('/api/roles',...protectedUserRoutes,async(req,res)=>{try{res.json((await pool.query('select id,code,name,description from roles order by id')).rows)}catch{res.status(500).json({error:'No se pudieron consultar los roles'})}});
  app.get('/api/users',...protectedUserRoutes,async(req,res)=>{try{res.json((await pool.query(`select u.id,u.name,u.email,u.phone,u.active,u.last_login_at,u.company_id,u.role_id,r.code role_code,r.name role_name,c.legal_name company_name from users u left join roles r on r.id=u.role_id left join companies c on c.id=u.company_id where ($1=true or u.company_id=$2) order by u.id desc`,[req.user.role_code==='admin',req.user.company_id])).rows)}catch{res.status(500).json({error:'No se pudieron consultar los usuarios'})}});
  app.post('/api/users',...protectedUserRoutes,async(req,res)=>{
    const b=req.body||{}; if(!clean(b.name)||!clean(b.email)||!clean(b.password)||!b.role_id)return res.status(400).json({error:'Nombre, correo, contraseña y rol son obligatorios'});
    if(String(b.password).length<10)return res.status(400).json({error:'La contraseña debe tener al menos 10 caracteres'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const companyId=req.user.role_code==='admin'?(b.company_id||req.user.company_id):req.user.company_id;
      const role=(await client.query('select id,code from roles where id=$1',[b.role_id])).rows[0];
      if(!role) throw new Error('Rol no encontrado');
      if(req.user.role_code!=='admin'&&role.code==='admin'){
        await client.query('ROLLBACK');
        return res.status(403).json({error:'No puedes asignar el rol administrador'});
      }
      const ph=await hashPassword(String(b.password));
      const r=await client.query('insert into users(company_id,role_id,name,email,password_hash,phone) values($1,$2,$3,$4,$5,$6) returning id',[companyId,b.role_id,clean(b.name),clean(b.email).toLowerCase(),ph,clean(b.phone)||null]);
      const user=await userView(client,r.rows[0].id);
      if(!user) throw new Error('No se pudo obtener el usuario creado');
      await writeAudit(client,req,{companyId,action:'create',entity:'user',entityId:r.rows[0].id,afterData:user});
      await client.query('COMMIT');
      res.status(201).json(user);
    } catch(e){
      await client.query('ROLLBACK');
      res.status(400).json({error:e.code==='23505'?'El correo ya existe':'No se pudo crear el usuario'});
    } finally {client.release();}
  });
  app.patch('/api/users/:id',...protectedUserRoutes,async(req,res)=>{
    const b=req.body||{};
    if(b.password&&String(b.password).length<10)return res.status(400).json({error:'La contraseña debe tener al menos 10 caracteres'});
    if(b.name===undefined&&b.phone===undefined&&b.role_id===undefined&&b.active===undefined&&!b.password)return res.status(400).json({error:'No hay cambios'});
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const isAdmin=req.user.role_code==='admin';
      const locked=(await client.query('select id from users where id=$1 and ($2=true or company_id=$3) for update',[req.params.id,isAdmin,req.user.company_id])).rows[0];
      if(!locked){await client.query('ROLLBACK');return res.sendStatus(404);}
      const before=await userAuditView(client,locked.id);
      if(!before) throw new Error('No se pudo obtener el usuario antes de actualizar');
      if(b.role_id!==undefined){
        const role=(await client.query('select id,code from roles where id=$1',[b.role_id])).rows[0];
        if(!role) throw new Error('Rol no encontrado');
        if(!isAdmin&&role.code==='admin'){
          await client.query('ROLLBACK');
          return res.status(403).json({error:'No puedes asignar el rol administrador'});
        }
      }
      const fields=[];const vals=[];const add=(sql,v)=>{fields.push(sql);vals.push(v)};
      if(b.name!==undefined)add('name=$'+(vals.length+1),clean(b.name));
      if(b.phone!==undefined)add('phone=$'+(vals.length+1),clean(b.phone)||null);
      if(b.role_id!==undefined)add('role_id=$'+(vals.length+1),b.role_id);
      if(b.active!==undefined)add('active=$'+(vals.length+1),!!b.active);
      if(b.password)add('password_hash=$'+(vals.length+1),await hashPassword(String(b.password)));
      vals.push(req.params.id);
      const r=await client.query(`update users set ${fields.join(',')},updated_at=now() where id=$${vals.length} and ($${vals.length+1}=true or company_id=$${vals.length+2}) returning id`,[...vals,isAdmin,req.user.company_id]);
      if(!r.rowCount) throw new Error('No se pudo actualizar el usuario autorizado');
      const after=await userAuditView(client,r.rows[0].id);
      if(!after) throw new Error('No se pudo obtener el usuario actualizado');
      const responseUser=await userView(client,r.rows[0].id);
      await writeAudit(client,req,{companyId:after.company_id,action:'update',entity:'user',entityId:r.rows[0].id,beforeData:before,afterData:after});
      await client.query('COMMIT');
      res.json(responseUser);
    } catch{
      await client.query('ROLLBACK');
      res.status(400).json({error:'No se pudo actualizar el usuario'});
    } finally {client.release();}
  });
}

async function authMiddleware(pool,req,res,next){
  const user=await authenticateToken(pool,req).catch(()=>null);
  if(!user)return res.status(401).json({error:'Autenticación requerida'});
  req.user=user;next();
}

function requirePermission(code){return (req,res,next)=>{if(!req.user)return res.status(401).json({error:'Autenticación requerida'});if(req.user.role_code==='admin'||(req.user.permissions||[]).includes(code))return next();res.status(403).json({error:`Permiso requerido: ${code}`});};}

module.exports={registerAuthRoutes,authMiddleware,requirePermission};
