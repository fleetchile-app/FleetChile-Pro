'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {MIGRATION_FILES}=require('../startup'),{registerFleetRoutes}=require('../fleet-api'),{registerFinanceRoutes}=require('../finance-api'),{registerEconomicsRoutes}=require('../economics-api'),{registerFinancialSupportRoutes}=require('../financial-support-api');
test('combustible web y respaldos: valoración pendiente, orígenes únicos, adjuntos privados, versiones y rollback',{skip:!process.env.FLEETCHILE_TEST_PGLITE},async t=>{
 const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE),db=new PGlite(),objects=new Map();let breakAudit=false,reads=0;
 const query=async(sql,args=[])=>{if(breakAudit&&sql.startsWith('insert into audit_logs'))throw Error('audit fixture');const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0};},pool={query,connect:async()=>({query,release(){}})},one=async(sql,args)=>(await query(sql,args)).rows[0];
 try{
  const source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');await db.exec(source('schema.sql'));await db.exec(source('migrations/002_core_platform.sql'));for(const m of MIGRATION_FILES)await db.exec(source('migrations/'+m));
  const cid=(await one("insert into companies(legal_name) values('Combustible QA') returning id")).id,other=(await one("insert into companies(legal_name) values('Otra QA') returning id")).id,role=(await one("select id from roles where code='company_admin'")).id;
  const uid=(await one("insert into users(company_id,role_id,name,email) values($1,$2,'Operador QA','fuel-support@example.invalid') returning id",[cid,role])).id;
  const truck=(await one("insert into trucks(company_id,patente,tipo) values($1,'FUELQA','Camión') returning id",[cid])).id;
  const trip=(await one("insert into trips(company_id,trip_number,truck_id,origin,destination) values($1,'FUEL-SUPPORT-QA',$2,'Origen','Destino') returning id",[cid,truck])).id;
  const actor={id:uid,name:'Operador QA',actor_type:'company',scope:'company',membership_id:1,company_id:cid,role_code:'operations',permissions:['fuel.manage','economics.read','economics.manage']},routes=[],app={};for(const m of ['get','post','patch','put','delete'])app[m]=(p,...h)=>routes.push({m,p,h});
  registerFleetRoutes(app,pool);registerEconomicsRoutes(app,pool);registerFinanceRoutes(app,pool);registerFinancialSupportRoutes(app,pool,{storage:{put:async({key,body})=>objects.set(key,Buffer.from(body)),get:async key=>{reads++;return {Body:objects.get(key)};},delete:async key=>objects.delete(key)}});
  async function call(m,p,{body={},params={},user=actor,filters={}}={}){const r=routes.find(r=>r.m===m&&r.p===p);assert.ok(r,p);const req={user,body,params,query:filters,ip:'127.0.0.1'},res={code:200,headers:{},status(n){this.code=n;return this},json(v){this.body=v;return this},send(v){this.body=v;return this},sendStatus(n){this.code=n;return this},set(k,v){this.headers[k]=v;return this},type(v){this.headers.type=v;return this}};let i=0;const next=()=>r.h[i++]?.(req,res,next);await next();return res;}
  let fuel,sourceId,cost;
  const png=await require('sharp')({create:{width:50,height:50,channels:3,background:'#173b5d'}}).png().toBuffer(),data='data:image/png;base64,'+png.toString('base64');
  await t.test('guarda abastecimiento interno sin precio, no lo transforma en cero ni ofrece un origen',async()=>{
   const r=await call('post','/api/fleet/fuel',{body:{truck_id:truck,liters:80,price_clp:null,valuation_pending:true,odometer_km:1000,date:'2026-10-30',supply_type:'internal',payment_method:'internal',receipt_reference:'VALE-123'}});assert.equal(r.code,201,JSON.stringify(r.body));fuel=r.body;assert.equal(fuel.price_clp,null);assert.equal(fuel.total_clp,null);
   const list=await call('get','/api/fleet/fuel',{filters:{include_summary:'true'}});assert.equal(list.body.totals.total_cost_clp,null);assert.equal(list.body.totals.pending_valuation_count,1);
   const options=await call('get','/api/economics/sources/fuel-options');assert.ok(!options.body.rows.some(f=>String(f.id)===String(fuel.id)));
   assert.equal((await call('post','/api/economics/sources',{body:{kind:'fuel',fuel_id:fuel.id,includes_vat:null,description:'Carga interna QA'}})).code,409);
  });
  await t.test('referencias y adjuntos opcionales; aislamiento y descarga verifica integridad',async()=>{
   const p={kind:'fuel',id:fuel.id};assert.equal((await call('post','/api/financial-support/:kind/:id',{params:p,body:{reference:'VALE-123'}})).code,201);
   const result=await call('post','/api/financial-support/:kind/:id',{params:p,body:{file:data}});assert.equal(result.code,201,JSON.stringify(result.body));const file=result.body;
   assert.equal((await call('get','/api/financial-support/:kind/:id',{params:p,user:{...actor,company_id:other}})).code,404);
   assert.equal((await call('post','/api/financial-support/:kind/:id',{params:p,user:{...actor,permissions:[]},body:{file:data}})).code,403);
   const list=await call('get','/api/financial-support/:kind/:id',{params:p});assert.equal(list.body.rows.length,2);assert.equal(list.body.reference,'VALE-123');assert.equal(list.body.rows.filter(r=>r.has_file).length,1);assert.doesNotMatch(JSON.stringify(list.body),/storage_key|companies\//);
   const dl=await call('get','/api/financial-support/:kind/:id/:fileId',{params:{...p,fileId:file.id}});assert.equal(dl.code,200);assert.deepEqual(dl.body,png);assert.equal(dl.headers['Cache-Control'],'private, no-store');
   const key=[...objects.keys()][0];objects.set(key,Buffer.alloc(png.length));assert.equal((await call('get','/api/financial-support/:kind/:id/:fileId',{params:{...p,fileId:file.id}})).code,503);objects.set(key,png);
   assert.equal((await call('get','/api/financial-support/:kind/:id/:fileId',{params:{...p,fileId:file.id},user:{...actor,company_id:other}})).code,404);assert.equal(reads,2);
  });
  await t.test('valoración con control de versión, origen único y respaldo heredado sin duplicar el gasto',async()=>{
   const p={id:fuel.id};assert.equal((await call('patch','/api/fleet/fuel/:id/valuation',{params:p,body:{price_clp:1100,version:0,reason:'Precio confirmado QA'}})).code,200);
   assert.equal((await call('patch','/api/fleet/fuel/:id/valuation',{params:p,body:{price_clp:1200,version:0,reason:'Editor obsoleto QA'}})).code,409);
   const r=await call('post','/api/economics/sources',{body:{kind:'fuel',fuel_id:fuel.id,includes_vat:null,description:'Origen desde combustible QA'}});assert.equal(r.code,201,JSON.stringify(r.body));sourceId=r.body.id;assert.equal(Number(r.body.amount_clp),88000);
   assert.notEqual((await call('post','/api/economics/sources',{body:{kind:'fuel',fuel_id:fuel.id,includes_vat:null,description:'Duplicado QA'}})).code,201);
   assert.equal((await call('patch','/api/fleet/fuel/:id/valuation',{params:p,body:{price_clp:1200,version:1,reason:'Importe ya vinculado'}})).code,409);
   const supports=await call('get','/api/financial-support/:kind/:id',{params:{kind:'source',id:sourceId}});assert.equal(supports.body.rows.length,2);assert.equal(supports.body.reference,'VALE-123');
  });
  await t.test('costo sin declaración documental y respaldos por versión, sin cambiar aprobaciones',async()=>{
   const r=await call('post','/api/economics/trips/:id/costs',{params:{id:trip},body:{category_code:'other_direct',amount_clp:500,cost_basis:'observed',support_status:null,description:'Gasto QA'}});assert.equal(r.code,201,JSON.stringify(r.body));cost=r.body;const version=cost.current_version_id;
   assert.equal((await call('post','/api/financial-support/:kind/:id',{params:{kind:'cost',id:version},body:{reference:'REF-QA'}})).code,201);
   const before=await one('select * from trip_cost_versions where id=$1',[version]);assert.equal(before.support_status,null);assert.equal(before.status,'draft');
   await query("update trip_finance_control set state='closed' where trip_id=$1",[trip]);assert.equal((await call('post','/api/financial-support/:kind/:id',{params:{kind:'cost',id:version},body:{reference:'NO-CERRADO'}})).code,409);
  });
  await t.test('auditoría fallida revierte metadatos y compensa el objeto; constraints multiempresa',async()=>{
   const n=objects.size;breakAudit=true;assert.equal((await call('post','/api/financial-support/:kind/:id',{params:{kind:'fuel',id:fuel.id},body:{file:data}})).code,503);breakAudit=false;assert.equal(objects.size,n);
   await assert.rejects(query('insert into financial_support_entries(company_id,cost_version_id,reference,created_by) values($1,$2,$3,$4)',[other,cost.current_version_id,'AJENO',uid]));
   await assert.rejects(query('update financial_support_entries set reference=$1 where fuel_id=$2',['MUTACION',fuel.id]));
  });
 }finally{await db.close();}
});
