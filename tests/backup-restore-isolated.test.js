'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const C = require('../backup-crypto');
const B = require('../backup-package'), Catalog = require('../backup-catalog'), { restoreDrill } = require('../backup-restore');
const { fixture, rewriteManifest, database, tools } = require('./backup-fixtures');
const isolated = { skip: !process.env.FLEETCHILE_TEST_PGLITE, timeout: 600000 };
const targetConfig = { bucket: 'fleetchile-drill-synthetic', credentials: { accessKeyId: 'drill-synthetic' } };
const drillEnv = { RESTORE_CONFIRM: 'isolated-local-drill', RESTORE_DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:55441/fleetchile_drill_synthetic' };

test('PL41 PGlite: mismo snapshot para catálogo/dump, todos tenants, derivadas y tombstones auditadas', isolated, async t => {
  const f = await fixture(t), backup = await f.backup(), stage = await B.verifiedStage(backup.directory, f.key);
  try {
    const m = stage.manifest;
    assert.equal(m.catalog.uniqueKeys, 3); assert.equal(f.calls.length, 3);
    assert.equal(m.catalog.referenceCount, 2);
    assert.equal(m.catalog.skippedDeletedReferences[0].count, 1);
    assert.equal(m.catalog.columns.length, 4);
    assert.ok(!f.calls.includes('companies/deleted/intentional'));
    assert.ok(f.calls.includes('companies/2/consent/private'));
    assert.ok(f.calls.includes('companies/2/exports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tar.gz'));
    assert.equal(m.tables.find(v => v.name === 'users').rows, 3);
    assert.equal(m.tables.find(v => v.name === 'platform_company_purge_files').rows, 1);
    assert.equal(m.tables.find(v => v.name === 'telemetry').rows, 1);
    assert.equal(m.tables.find(v => v.name === 'driver_mobile_actions').rows, 1);
    assert.deepEqual(m.excludedEphemeral.map(v => v.table).sort(), ['driver_tracking_positions','driver_tracking_sessions','user_sessions']);
    for (const name of m.excludedEphemeral.map(v => v.table)) {
      const table = m.tables.find(v => v.name === name); assert.equal(table.rows,0);
      assert.equal(table.sha256, require('node:crypto').createHash('sha256').digest('hex'));
    }
    assert.match(f.client.log[0], /REPEATABLE READ READ ONLY/);
    assert.equal(f.client.log.filter(sql => sql.startsWith('BEGIN')).length, 1);
    assert.equal(f.client.log.at(-1),'COMMIT');
    for (const entry of await fs.promises.readdir(backup.directory)) {
      const bytes = await fs.promises.readFile(path.join(backup.directory, entry));
      assert.ok(!bytes.includes(Buffer.from('synthetic hash A')));
      assert.ok(!bytes.includes(Buffer.from('companies/1/pod/private')));
    }
  } finally { await stage.cleanup(); }
});

test('PL41 drill SQL aislado + S3 fake: datos y hashes iguales, FK GPS sin sesiones, audits/GPS preservados', isolated, async t => {
  const f = await fixture(t), backup = await f.backup();
  const { PGlite } = require(process.env.FLEETCHILE_TEST_PGLITE), target = new PGlite(); t.after(() => target.close());
  const dest = new Map(), actions = [], targetClient = database(target);
  const store = { async assertEmpty() { assert.equal(dest.size,0); }, async put(key, body) { actions.push('put'); const chunks=[]; for await (const b of body) chunks.push(b); dest.set(key,Buffer.concat(chunks)); }, async get(key) { return { Body: dest.get(key) }; }, close() {} };
  const result = await restoreDrill({ dir: backup.directory, key: f.key, env: drillEnv, targetConfig,
    makeClient: () => targetClient, makeStore: () => store, tools: async () => tools,
    async restore(cfg,file) { actions.push('restore-synthetic-transport'); assert.equal(dest.size,3); const dump=await fs.promises.readFile(file,'utf8'); assert.ok(dump.startsWith('PGDMP')); await target.exec(dump.slice(5)); } });
  assert.equal(result.status,'isolated-drill-verified'); assert.equal(result.sessionsRevoked,true);
  assert.deepEqual(actions,['put','put','put','restore-synthetic-transport']);
  for (const name of ['user_sessions','driver_tracking_sessions','driver_tracking_positions']) assert.equal((await target.query(`select count(*)::int as count from ${name}`)).rows[0].count,0);
  for (const name of ['telemetry','driver_mobile_actions','issued_documents','platform_company_purge_files']) assert.equal((await target.query(`select count(*)::int as count from ${name}`)).rows[0].count,1);
  assert.equal((await target.query('select count(*)::int as count from audit_logs')).rows[0].count,2);
  assert.equal((await target.query('select count(*)::int as count from users')).rows[0].count,3);
  for (const [key,value] of f.sourceObjects) assert.deepEqual(dest.get(key),value);
  assert.ok(!targetClient.log.some(sql => /DROP|TRUNCATE/.test(sql)));
});

test('PL41 faltante vivo/expiración/cleanup pendiente/hash erróneo/overwrite posterior abortan sin READY', isolated, async t => {
  for (const scenario of ['live','export-expired-race','purge-pending','hash','post-snapshot','stream-failure']) await t.test(scenario, async t => {
    const f = await fixture(t);
    if (scenario === 'live') f.sourceObjects.delete('companies/1/pod/private');
    if (scenario === 'export-expired-race') f.sourceObjects.delete('companies/2/exports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tar.gz');
    if (scenario === 'purge-pending') await f.db.query("insert into platform_company_purge_files values(2,'companies/pending/not-present',NULL)");
    if (scenario === 'hash') f.sourceObjects.set('companies/1/pod/private',Buffer.from('same length bad'));
    if (scenario === 'post-snapshot') { const get = f.store.get; f.store.get = async key => ({ ...await get(key), LastModified: new Date('2099-01-01') }); }
    if (scenario === 'stream-failure') f.store.get = async () => ({ Body: require('node:stream').Readable.from((async function* () { yield Buffer.from('partial'); throw Error('synthetic stream failure'); })()) });
    await assert.rejects(f.backup());
    const dirs = await fs.promises.readdir(f.root);
    assert.equal(dirs.length,1); assert.equal(fs.existsSync(path.join(f.root,dirs[0],'READY.json')),false);
    assert.equal(f.client.log.at(-1),'ROLLBACK');
  });
});

test('PL41 manifiesto/árbol/cipher alterados se rechazan ANTES de contactar destinos', isolated, async t => {
  const f = await fixture(t), baseline = await f.backup();
  for (const kind of ['cipher','version','path','duplicate','catalog','ephemeral-policy','extra','missing','schema']) await t.test(kind, async t => {
    const parent = await C.privateDir(path.join(f.root,'case-'+kind)), b={directory:path.join(parent,path.basename(baseline.directory))};
    await fs.promises.cp(baseline.directory,b.directory,{recursive:true});
    if (kind === 'cipher') { const file=path.join(b.directory,'object-0.fcbak.enc'), bytes=await fs.promises.readFile(file); bytes[23]^=1; await fs.promises.writeFile(file,bytes); }
    else if (kind === 'extra') await fs.promises.writeFile(path.join(b.directory,'foreign.txt'),'synthetic foreign file');
    else if (kind === 'missing') await fs.promises.rm(path.join(b.directory,'object-0.fcbak.enc'));
    else await rewriteManifest(b.directory,f.key,m => {
      if (kind === 'version') m.version=999;
      if (kind === 'path') m.files[1].file='../outside';
      if (kind === 'duplicate') m.files[2].file=m.files[1].file;
      if (kind === 'catalog') m.catalog.objects.pop();
      if (kind === 'ephemeral-policy') m.excludedEphemeral=[];
      if (kind === 'schema') m.schema.tables.pop();
    });
    let contacted = 0;
    await assert.rejects(restoreDrill({ dir:b.directory,key:f.key,env:drillEnv,targetConfig,makeClient:()=>{ contacted++; throw Error('no contact'); },makeStore:()=>{ contacted++; throw Error('no contact'); },tools:async()=>{contacted++; return tools;} }));
    assert.equal(contacted,0);
  });
});

test('PL41 destino no vacío y S3 readback corrupto no ejecutan pg_restore', isolated, async t => {
  for (const kind of ['database','bucket','readback']) await t.test(kind,async t => {
    const f = await fixture(t), b=await f.backup(), { PGlite }=require(process.env.FLEETCHILE_TEST_PGLITE), target=new PGlite(); t.after(()=>target.close());
    if (kind === 'database') await target.exec('create table occupied(id int)');
    let restores=0;
    await assert.rejects(restoreDrill({dir:b.directory,key:f.key,env:drillEnv,targetConfig,tools:async()=>tools,makeClient:()=>database(target),makeStore:()=>({ async assertEmpty(){if(kind==='bucket')throw Error('synthetic occupied');},async put(k,b){for await(const c of b){}},async get(){return {Body:Buffer.from('corrupt')};} }),restore:async()=>{restores++;} }));
    assert.equal(restores,0);
  });
});

test('PL41 retención sólo opt-in en bundles propios autenticados; conserva más reciente y archivos ajenos', isolated, async t => {
  const f = await fixture(t), first=await f.backup(), second=await f.backup();
  await rewriteManifest(first.directory,f.key,m=>{m.createdAt='2020-01-01T00:00:00.000Z';});
  await fs.promises.writeFile(path.join(f.root,'foreign.txt'),'keep');
  await assert.rejects(B.retain({root:f.root,key:f.key,days:1}), /EXPLICIT_APPLY/);
  const r=await B.retain({root:f.root,key:f.key,days:1,keep:1,apply:true,now:Date.parse('2026-10-31T00:00:00Z')});
  assert.equal(r.removed,1); assert.equal(fs.existsSync(first.directory),false); assert.equal(fs.existsSync(second.directory),true); assert.equal(fs.existsSync(path.join(f.root,'foreign.txt')),true);
});

test('PL41 esquema real completo hasta 053: catálogo pg_catalog + política efímera compatible', isolated, async t => {
  const {PGlite}=require(process.env.FLEETCHILE_TEST_PGLITE), db=new PGlite(); t.after(()=>db.close());
  const root=path.join(__dirname,'..'); await db.exec(await fs.promises.readFile(path.join(root,'schema.sql'),'utf8'));
  for(const name of (await fs.promises.readdir(path.join(root,'migrations'))).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort()) await db.exec(await fs.promises.readFile(path.join(root,'migrations',name),'utf8'));
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const state=await Catalog.inventory(db);
    const expected=(await db.query("select count(*)::int as count from information_schema.columns where column_name='storage_key' and table_schema='public'")).rows[0].count;
    assert.equal(state.catalog.columns.filter(c=>c.column==='storage_key').length,expected);
    assert.ok(expected>=5);
    assert.ok(state.excludedEphemeral.some(v=>v.table==='driver_tracking_sessions'));
    assert.ok(state.excludedEphemeral.some(v=>v.table==='driver_tracking_positions'));
    for(const name of ['telemetry','driver_mobile_actions','audit_logs']) assert.equal(state.tables.find(t=>t.name===name).ephemeralExcluded,false);
    await db.query('COMMIT');
  } catch(e) { await db.query('ROLLBACK'); throw e; }
});
