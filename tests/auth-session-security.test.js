'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {registerAuthRoutes,reauthenticateUser}=require('../auth');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const hashPassword=password=>{const salt=crypto.randomBytes(16).toString('hex');return `scrypt$${salt}$${crypto.scryptSync(password,salt,64,{N:16384,r:8,p:1}).toString('hex')}`;};

async function harness({fail,wrong=false}={}){
 const initial=await hashPassword('OldPassword123'),state={hash:initial,sessions:[digest('current'),digest('other')]},calls=[];
 let backup,released=0;
 const query=async(sql,v=[])=>{
  calls.push({sql,v});
  if(fail&&sql.startsWith(fail))throw Error('Simulated internal failure');
  if(sql.startsWith('select s.user_id'))return {rows:[{user_id:7}],rowCount:1};
  if(sql.includes('po.owner_type ownership_role'))return {rows:[{id:7,company_id:null,role_code:'admin',memberships:[],platform_memberships:[]}],rowCount:1};
  if(sql.startsWith('update user_sessions set last_seen_at'))return {rows:[]};
  if(sql==='BEGIN'){backup=structuredClone(state);return {rows:[]};}
  if(sql==='ROLLBACK'){Object.assign(state,backup);return {rows:[]};}
  if(sql==='COMMIT')return {rows:[]};
  if(sql.startsWith('select password_hash')){assert.match(sql,/for update$/);assert.deepEqual(v,[7]);return {rows:[{password_hash:state.hash}]};}
  if(sql.startsWith('update users set password_hash')){state.hash=v[0];return {rows:[]};}
  if(sql.startsWith('delete from user_sessions')){assert.deepEqual(v,[7,digest('current')]);state.sessions=state.sessions.filter(s=>s===v[1]);return {rows:[]};}
  if(sql.startsWith('insert into audit_logs')){assert.equal(v[1],7);assert.equal(v[2],'password_change');assert.equal(v[6].other_sessions_revoked,true);assert.doesNotMatch(JSON.stringify(v),/OldPassword123|NewPassword123|scrypt\$/);return {rows:[]};}
  throw Error(sql);
 };
 const pool={query,async connect(){return {query,release(){released++;}};}};
 const routes=[],app={};for(const method of ['get','post','patch','put','delete'])app[method]=(path,...handlers)=>routes.push({method,path,handlers});
 registerAuthRoutes(app,pool);
 const req={body:{current_password:wrong?'WrongPassword123':'OldPassword123',new_password:'NewPassword123',confirm_password:'NewPassword123'},ip:'127.0.0.1',get:name=>name==='authorization'?'Bearer current':''};
 const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.payload=v;return this;}};
 await routes.find(r=>r.path==='/api/auth/change-password').handlers.at(-1)(req,res);
 return {state,initial,calls,res,released};
}
test('cambiar contraseña revoca las otras sesiones, conserva la actual y audita al actor real',async()=>{
 const h=await harness();assert.equal(h.res.statusCode,200);assert.equal(h.released,1);
 assert.deepEqual(h.state.sessions,[digest('current')]);assert.equal(await reauthenticateUser({query:async()=>({rowCount:1,rows:[{password_hash:h.state.hash}]})},7,'NewPassword123'),true);
 assert.equal(h.calls.at(-1).sql,'COMMIT');
});
test('contraseña incorrecta se verifica bajo bloqueo y no revoca ni actualiza',async()=>{
 const h=await harness({wrong:true});assert.equal(h.res.statusCode,403);assert.equal(h.state.hash,h.initial);
 assert.equal(h.state.sessions.length,2);assert.equal(h.calls.at(-1).sql,'ROLLBACK');
 assert.equal(h.calls.some(c=>c.sql.startsWith('delete from user_sessions')),false);
});
for(const fail of ['delete from user_sessions','insert into audit_logs','COMMIT'])test(`fallo ${fail} revierte contraseña y sesiones conjuntamente`,async()=>{
 const h=await harness({fail});assert.equal(h.res.statusCode,400);assert.equal(h.state.hash,h.initial);
 assert.equal(h.state.sessions.length,2);assert.equal(h.calls.at(-1).sql,'ROLLBACK');assert.equal(h.released,1);
 assert.doesNotMatch(h.res.payload.error,/internal|Simulated/);
});
