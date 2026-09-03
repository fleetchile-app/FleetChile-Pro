const test=require('node:test');
const assert=require('node:assert/strict');
const {registerCoreRoutes}=require('../core-api');

function app(){const routes=[];for(const method of ['get','post','put','patch','delete'])routes[method]=(path,...handlers)=>routes.push({method,path,handlers});routes.route=(m,p)=>routes.find(x=>x.method===m&&x.path===p);return routes}
function res(){return{statusCode:200,payload:null,status(c){this.statusCode=c;return this},json(v){this.payload=v},sendStatus(c){this.statusCode=c}}}
async function run(user){const calls=[];const pool={async query(sql,values=[]){calls.push({sql,values});return{rows:[{n:1}],rowCount:1}},async connect(){return this},release(){}};const a=app();registerCoreRoutes(a,pool);const req={user,body:{},query:{},params:{},get(){return''}};const response=res();let i=0;const next=async()=>{const h=a.route('get','/api/core/summary').handlers[i++];if(h)return h(req,response,next)};await next();return{calls,response}}
const platform=(context)=>({id:1,actor_type:'platform',scope:context?'company':'platform',company_id:context||null,platform_membership_id:7,permissions:['dashboard.read'],role_code:'platform_superadmin'});

test('core usa contexto de empresa para platform y no inventa empresa en global',async()=>{
  const global=await run(platform(null));assert.equal(global.calls.find(x=>x.sql.includes('from clients'))?.values[0],null);
  const a=await run(platform(10));assert.equal(a.calls.find(x=>x.sql.includes('from clients'))?.values[0],10);
  const b=await run(platform(20));assert.equal(b.calls.find(x=>x.sql.includes('from clients'))?.values[0],20);
  assert.notEqual(a.calls.find(x=>x.sql.includes('from clients')).values[0],b.calls.find(x=>x.sql.includes('from clients')).values[0]);
});
