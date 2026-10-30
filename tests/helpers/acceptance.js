'use strict';
// Synthetic acceptance data only. This helper never reads DATABASE_URL.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {MIGRATION_FILES}=require('../../startup');
const auth=require('../../auth');
const password='Acceptance-fixture-only-2026';
const hashPassword=async value=>{const salt=crypto.randomBytes(16).toString('hex');return 'scrypt$'+salt+'$'+crypto.scryptSync(value,salt,64,{N:16384,r:8,p:1}).toString('hex');};
async function initialize(execute){for(const f of ['schema.sql','migrations/002_core_platform.sql',...MIGRATION_FILES.map(f=>'migrations/'+f)])await execute(fs.readFileSync(path.join(__dirname,'../..',f),'utf8'));}
async function embedded(){const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),pg=new PGlite();const query=async(sql,args=[])=>{const r=await pg.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0};};try{await initialize(sql=>pg.exec(sql));return {pool:{query,connect:async()=>({query,release(){}})},execute:sql=>pg.exec(sql),close:()=>pg.close()};}catch(e){await pg.close();throw e;}}
async function harness(pool){
 const one=async(sql,args)=>(await pool.query(sql,args)).rows[0],routes=[],app={};for(const method of ['get','post','put','patch','delete'])app[method]=(url,...handlers)=>routes.push({method,url,handlers});
 const objects=new Map(),storage={async put({key,body}){objects.set(key,Buffer.from(body));},async get(key){if(!objects.has(key))throw Error('Synthetic attachment unavailable');return {Body:objects.get(key)};},async head(key){if(!objects.has(key))throw Object.assign(Error('Missing fixture'),{notFound:true});return {};},async delete(key){objects.delete(key);}};
 require('../../core-api').registerCoreRoutes(app,pool);await require('../../fleet-api').registerFleetRoutes(app,pool);require('../../operations-api').registerOperationsRoutes(app,pool,{storage});
 require('../../personnel-api').registerPersonnelRoutes(app,pool,{resolveActorContext:auth.resolveActorContext,hashPassword,reauthenticateUser:auth.reauthenticateUser});
 require('../../economics-api').registerEconomicsRoutes(app,pool);require('../../finance-api').registerFinanceRoutes(app,pool);require('../../commercial-api').registerCommercialRoutes(app,pool);
 require('../../enterprise-api').registerEnterpriseRoutes(app,pool);
 require('../../itinerary-api').registerItineraryRoutes(app,pool,{async route(a,b){return {distance_meters:1000,duration_seconds:600,provider:'synthetic-acceptance-not-real-routing',calculated_at:new Date().toISOString(),geometry:{type:'LineString',coordinates:[[a.lng,a.lat],[b.lng,b.lat]]}};}});
 const middleware=auth.authMiddleware.bind(null,pool),commercial=require('../../commercial-gate').commercialGate(pool);
 async function session(userId){const token=crypto.randomBytes(32).toString('hex');await pool.query("insert into user_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour')",[userId,crypto.createHash('sha256').update(token).digest('hex')]);return token;}
 async function account(cid,roleCode,name,rut='11111111-1'){
  const role=await one('select id from roles where code=$1',[roleCode]),u=await one('insert into users(company_id,role_id,name,email,password_hash,active) values($1,$2,$3,$4,$5,true) returning id',[cid,role.id,name,crypto.randomUUID()+'@acceptance.invalid',await hashPassword(password)]);
  if(cid){const m=await one('insert into user_memberships(company_id,user_id,role_id) values($1,$2,$3) returning id',[cid,u.id,role.id]),p=await one("insert into company_people(company_id,user_id,membership_id,name,rut,birth_date,created_by) values($1,$2,$3,$4,$5,'1990-01-01',$2) returning id",[cid,u.id,m.id,name,rut]);await pool.query("insert into person_contracts(company_id,person_id,type,start_date,created_by) values($1,$2,'indefinite','2000-01-01',$3)",[cid,p.id,u.id]);}
  else await pool.query('insert into platform_memberships(user_id,role_id) values($1,$2)',[u.id,role.id]);
  return {id:Number(u.id),token:await session(u.id)};
 }
 async function company(name){const c=await one('insert into companies(legal_name,user_limit) values($1,25) returning id',[name]);return {id:Number(c.id),admin:await account(c.id,'company_admin',name+' admin'),approver:await account(c.id,'company_admin',name+' approver','22222222-2')};}
 async function run(token,method,url,{body={},params={},query={},headers={}}={}){
  const matching=routes.filter(r=>r.method===method&&r.url===url);assert.ok(matching.length,method+' '+url);
  const actual=url.replace(/:([A-Za-z]+)/g,(_,key)=>String(params[key]??'')),req={method:method.toUpperCase(),originalUrl:actual,path:actual,body,params,query,ip:'127.0.0.1',get:key=>key.toLowerCase()==='authorization'&&token?'Bearer '+token:headers[key.toLowerCase()]||''};
  const res={statusCode:200,headers:{},status(n){this.statusCode=n;return this},json(v){this.payload=v;return this},send(v){this.payload=v;return this},sendStatus(n){this.statusCode=n;return this},set(k,v){this.headers[k]=v;return this},type(v){this.headers.type=v;return this}};
  const handlers=[middleware,commercial,...matching.flatMap(r=>r.handlers)];async function next(i){if(i>=handlers.length)return;let work;await handlers[i](req,res,()=>work=next(i+1));if(work)await work;}await next(0);return res;
 }
 return {one,run,session,account,company,objects,storage,password};
}
module.exports={initialize,embedded,harness,password};
