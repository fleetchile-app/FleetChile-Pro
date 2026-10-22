'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const monitor=require('../personnel-monitor');

function eligibilityPool({allowed=true}={}){
 const calls=[];
 return {calls,async query(sql,params){
  calls.push({sql,params});
  if(sql.startsWith('select pc.id'))return {rows:[{id:7,company_id:3,person_id:11,end_date:'2026-10-20',time_zone:'America/Santiago'}]};
  if(sql.includes('jsonb_build_object'))return {rows:[{personnel_state:{
   policy:{enforced:true,time_zone:'America/Santiago'},
   person:{id:11,user_id:21,rut:'12345678-5',birth_date:'1980-01-01',contract_exempt:true,exemption_by:1,exemption_at:'2026-01-01T00:00:00.000Z'},
   membership:{active:true,role_code:'company_admin'},account_active:true,
   contracts:[],conditions:[],licenses:[]
  }}]};
  if(sql.includes('insert into personnel_notifications'))return {rowCount:1,rows:[{id:99}]};
  if(sql.includes('personnel_state'))throw new Error('unexpected direct snapshot query');
  return {rows:[]};
 }};
}

test('monitor is limited to new-schema, non-cancelled conditions and timezone-aware inclusive end dates',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','personnel-monitor.js'),'utf8');
 assert.match(source,/pc\.cancelled_at is null/);
 assert.match(source,/pc\.created_at is not null/);
 assert.match(source,/pc\.end_date::text as end_date/);
 assert.match(source,/pc\.end_date < \(\(\$1::timestamptz at time zone cp\.time_zone\)::date\)/);
 assert.match(source,/not exists\(\s*select 1 from personnel_notifications pn/s);
 assert.match(source,/String\(condition\.end_date\)<today/);
});

test('reconcile uses loadEligibility result, safe wording, and dedupes extensions',async()=>{
 const pool=eligibilityPool();
 const result=await monitor.reconcilePersonnelNotifications(pool,{now:new Date('2026-10-22T01:00:00.000Z')});
 assert.equal(result.scanned,1);
 assert.equal(result.created,1);
 const insert=pool.calls.find(call=>call.sql.includes('insert into personnel_notifications'));
 assert.deepEqual(insert.params,[3,11,'condition-ended:7:2026-10-20','condition-ended','El período terminó; retorno automático habilitado']);
 assert.match(insert.sql,/on conflict\(company_id,event_key\) do nothing/);
});

test('monitor never reactivates accounts and does not expose medical condition data',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','personnel-monitor.js'),'utf8');
 assert.doesNotMatch(source,/update\s+users|update\s+user_memberships/i);
 assert.doesNotMatch(source,/medical|sick|health|diagnos/i);
});

test('start runs asynchronously once, prevents overlap, unreferences timer, and stops',async()=>{
 let calls=0,resolve;
 const pool={query:async sql=>{
  if(sql.startsWith('select pc.id')){calls++;return new Promise(r=>{resolve=()=>r({rows:[]})})}
  return {rows:[]};
 }};
 const timer=setTimeout(()=>{},100000);
 const originalSetInterval=global.setInterval;
 const originalClearInterval=global.clearInterval;
 let intervalCallback,cleared=false,unref=false;
 global.setInterval=(callback)=>{intervalCallback=callback;return {unref:()=>{unref=true}}};
 global.clearInterval=()=>{cleared=true};
 try{
  const stop=monitor.startPersonnelMonitor(pool,{intervalMs:1,logger:{error(){}}});
  assert.equal(calls,1);
  intervalCallback();
  assert.equal(calls,1,'no overlap while initial reconciliation is pending');
  // stop() must await the in-flight initial reconciliation before pool.end().
  const stopping=stop();
  resolve();
  await stopping;
  assert.equal(cleared,true);
  assert.equal(unref,true);
 }finally{
  clearTimeout(timer);global.setInterval=originalSetInterval;global.clearInterval=originalClearInterval;
 }
});
