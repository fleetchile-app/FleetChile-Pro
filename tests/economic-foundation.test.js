const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const {initializeDatabase}=require('../startup');

const migrationPath=path.join(__dirname,'..','migrations','015_economic_foundation.sql');
const sql=fs.readFileSync(migrationPath,'utf8');

test('migración económica es aditiva, transaccional y no interpreta datos legacy',()=>{
  assert.match(sql,/^\s*--[\s\S]*?\bBEGIN;/i);
  assert.match(sql,/\bCOMMIT;\s*$/i);
  assert.doesNotMatch(sql,/\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(sql,/\bUPDATE\s+trips\b/i);
  assert.doesNotMatch(sql,/\bINSERT\s+INTO\s+trip_economic_profiles\b/i);
  assert.doesNotMatch(sql,/\brevenue_clp\s*=\s*0\b/i);
});

test('migración crea perfiles e historial de ingresos con consistencia company-scoped',()=>{
  assert.match(sql,/CREATE TABLE IF NOT EXISTS trip_economic_profiles/i);
  assert.match(sql,/trip_id BIGINT PRIMARY KEY REFERENCES trips\(id\)/i);
  assert.match(sql,/company_id BIGINT NOT NULL REFERENCES companies\(id\)/i);
  assert.match(sql,/FOREIGN KEY \(company_id, trip_id\) REFERENCES trips\(company_id, id\)/i);
  assert.match(sql,/economic_status IN \('open','pending_reconciliation','ready_to_close','closed'\)/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS trip_revenue_history/i);
  assert.match(sql,/previous_revenue_clp IS NULL OR previous_revenue_clp >= 0/i);
  assert.match(sql,/new_revenue_clp IS NULL OR new_revenue_clp >= 0/i);
  assert.match(sql,/new_revenue_clp <> 0[\s\S]*?NULLIF\(BTRIM\(zero_justification\), ''\) IS NOT NULL/i);
});

test('catálogo económico contiene solo las seis categorías iniciales y comisión inactiva',()=>{
  const values=[...sql.matchAll(/\('([^']+)','[^']+','direct',(true|false)\)/g)].map(match=>({code:match[1],active:match[2]}));
  assert.deepEqual(values,[
    {code:'fuel',active:'true'},
    {code:'toll',active:'true'},
    {code:'parking',active:'true'},
    {code:'per_diem',active:'true'},
    {code:'other_direct',active:'true'},
    {code:'commission',active:'false'}
  ]);
  assert.match(sql,/ON CONFLICT \(code\) DO NOTHING/i);
});

test('cost items y versiones restringen estados, bases, importes y versión actual',()=>{
  assert.match(sql,/CREATE TABLE IF NOT EXISTS trip_cost_items/i);
  assert.match(sql,/status IN \('active','reconciled','voided'\)/i);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS trip_cost_versions/i);
  assert.match(sql,/cost_basis IN \('planned','observed','allocated','indirect'\)/i);
  assert.match(sql,/amount_clp >= 0/i);
  assert.match(sql,/UNIQUE \(trip_cost_item_id, version_number\)/i);
  assert.match(sql,/support_status <> 'undocumented'[\s\S]*?NULLIF\(BTRIM\(justification\), ''\) IS NOT NULL/i);
  assert.match(sql,/FOREIGN KEY \(id, current_version_id\)[\s\S]*?REFERENCES trip_cost_versions\(trip_cost_item_id, id\)/i);
});

test('permisos económicos y matriz inicial respetan roles existentes',()=>{
  for(const permission of ['economics.read','economics.manage','economics.approve','economics.close','economics.export']){
    assert.match(sql,new RegExp(`'${permission.replace('.','\\.')}'`));
  }
  assert.match(sql,/r\.code = 'operations'[\s\S]*?'economics\.read','economics\.manage','economics\.export'/i);
  assert.match(sql,/r\.code = 'manager'[\s\S]*?'economics\.read','economics\.manage','economics\.approve','economics\.close','economics\.export'/i);
  assert.match(sql,/r\.code = 'viewer' AND p\.code = 'economics\.read'/i);
  assert.match(sql,/r\.code = 'admin'/i);
  assert.doesNotMatch(sql,/r\.code = 'maintenance'/i);
  assert.doesNotMatch(sql,/r\.code = 'driver'/i);
});

test('startup entrega la migración 015 al mismo cliente en dos inicializaciones',async()=>{
  let foundationRuns=0;
  const client={
    async query(statement){
      if(statement.startsWith('select count'))return {rows:[{count:1}]};
      if(statement.includes('CREATE TABLE IF NOT EXISTS trip_economic_profiles'))foundationRuns++;
      return {rows:[]};
    },
    release(){}
  };
  const pool={async connect(){return client}};
  const options={baseDir:path.join(__dirname,'..'),initializeCorePlatform:async()=>{},logger:{log(){}}};
  await initializeDatabase(pool,options);
  await initializeDatabase(pool,options);
  assert.equal(foundationRuns,2);
});
