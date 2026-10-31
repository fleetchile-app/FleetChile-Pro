'use strict';
// Optional real pg_dump/pg_restore test. Creates its OWN two clusters, never uses DATABASE_URL.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), http = require('node:http'), crypto = require('node:crypto');
const { promisify } = require('node:util'), { execFile } = require('node:child_process');
const C = require('../backup-crypto'), PG = require('../backup-postgres'), S3 = require('../backup-s3'), B = require('../backup-package');
const { restoreDrill } = require('../backup-restore');
const { sql, ephemeralSQL, objects } = require('./backup-fixtures');
const exec = promisify(execFile);
const listen = server => new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',()=>resolve(server.address().port)); });
const close = server => new Promise(resolve => server.close(resolve));

test('PL41 NATIVO dos clusters temporales: pg_dump snapshot/custom -> AES -> S3 HTTP fake -> pg_restore real',
  { skip: !process.env.PL41_NATIVE_PG_BIN, timeout: 600000 }, async t => {
    const bin = path.resolve(process.env.PL41_NATIVE_PG_BIN), suffix = process.platform === 'win32' ? '.exe' : '';
    for (const name of ['initdb','pg_ctl','postgres','pg_dump','pg_restore']) assert.ok(fs.existsSync(path.join(bin,name+suffix)), `Falta ${name} en PL41_NATIVE_PG_BIN`);
    const parent=path.resolve(process.env.PL41_NATIVE_TEMP_ROOT || os.tmpdir());
    const root = await C.tempDir(parent,'pl41-native-'), key=crypto.randomBytes(32), env={ BACKUP_PG_BIN:bin, ...PG.childEnv(process.env) };
    console.log('PL41 native temporary log directory: '+root);
    const started=[], clients=[], buckets=new Map([['source-fixture-private',new Map(objects)],['fleetchile-drill-native',new Map()],['source-fixture-empty',new Map()],['fleetchile-drill-native-full',new Map()]]);
    let s3server;
    const tool=async(name,args)=>{ try { return await exec(path.join(bin,name+suffix),args,{env:PG.childEnv(process.env),windowsHide:true,timeout:60000,maxBuffer:1024*1024}); } catch { throw C.fail('BACKUP_NATIVE_TEMPORARY_CLUSTER_TOOL_FAILED'); } };
    t.after(async()=>{
      let stoppedAll=true;
      try {
        for(const client of clients) try { await client.end(); } catch {}
        if(s3server) await close(s3server);
        for(const dir of started.reverse()) try { await tool('pg_ctl',['-D',dir,'stop','--mode=fast','--wait']); } catch { stoppedAll=false; }
      } finally {
        key.fill(0);
        assert.equal(path.dirname(root),parent); assert.ok(path.basename(root).startsWith('pl41-native-'));
        if(stoppedAll) await fs.promises.rm(root,{recursive:true,force:true});
        else throw C.fail('BACKUP_NATIVE_CLUSTER_STOP_FAILED_KEEP_TEMP_FOR_REVIEW');
      }
    });
    async function cluster(label) {
      const dir=path.join(root,label), probe=net.createServer(), port=await listen(probe); await close(probe);
      await tool('initdb',['-D',dir,'--username=pl41_test','--auth=trust','--encoding=UTF8','--no-locale']);
      // Track before waiting: a timed-out launcher may still have started PostgreSQL.
      started.push(dir);
      await tool('pg_ctl',['-D',dir,'-l',path.join(root,label+'.log'),'-o',`-h 127.0.0.1 -p ${port}`,'start','--wait']);
      return {port,url:`postgresql://pl41_test:synthetic@127.0.0.1:${port}/postgres`};
    }
    const source=await cluster('source'), target=await cluster('target'); assert.notEqual(source.port,target.port);
    for(const [cluster,name] of [[source,'pl41_synthetic_source'],[target,'fleetchile_drill_native']]) {
      const admin=PG.connect(PG.database(cluster.url),{}); await admin.connect();
      try { await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); } finally { await admin.end(); }
      cluster.url=cluster.url.replace('/postgres','/'+name);
    }
    const cfg=PG.database(source.url), db=PG.connect(cfg,{}); clients.push(db); await db.connect(); await db.query(sql+ephemeralSQL);
    s3server=http.createServer(async(req,res)=>{
      try {
        const url=new URL(req.url,'http://127.0.0.1'), parts=url.pathname.slice(1).split('/').map(decodeURIComponent), bucket=parts.shift(), key=parts.join('/'), map=buckets.get(bucket);
        if(!map){res.writeHead(404);res.end();return;}
        if(req.method==='GET' && url.searchParams.has('list-type')) {
          res.setHeader('Content-Type','application/xml'); res.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><KeyCount>${map.size?1:0}</KeyCount><IsTruncated>false</IsTruncated>${map.size?'<Contents><Key>occupied</Key></Contents>':''}</ListBucketResult>`); return;
        }
        if(req.method==='GET' && map.has(key)) {
          const body=map.get(key); res.setHeader('Content-Length',body.length);res.setHeader('Last-Modified','Wed, 01 Jan 2020 00:00:00 GMT');res.setHeader('Content-Type','application/octet-stream');res.end(body);return;
        }
        if(req.method==='PUT') {
          assert.ok(['fleetchile-drill-native','fleetchile-drill-native-full'].includes(bucket)); assert.equal(req.headers['if-none-match'],'*');
          if(map.has(key)){res.writeHead(412);res.end();return;}
          const chunks=[];for await(const c of req)chunks.push(c);map.set(key,Buffer.concat(chunks));res.setHeader('ETag','"synthetic"');res.end();return;
        }
        res.writeHead(404);res.end('<Error><Code>NoSuchKey</Code></Error>');
      } catch { res.writeHead(500);res.end(); }
    });
    const s3port=await listen(s3server), endpoint=`http://127.0.0.1:${s3port}`;
    const sourceS3={bucket:'source-fixture-private',region:'us-east-1',endpoint,forcePathStyle:true,credentials:{accessKeyId:'synthetic-source',secretAccessKey:'synthetic-source-secret'}};
    const sourceStore=S3.adapter(sourceS3);
    let backup;
    try { backup=await B.createBackup({db,cfg,store:sourceStore,sourceBucket:sourceS3.bucket,root:path.join(root,'bundles'),key,tools:await PG.tools(env),env:{...env,BACKUP_OBJECTS_QUIESCED:'yes'}}); } finally { sourceStore.close(); }
    const restoreEnv={...env,BACKUP_DATABASE_URL:source.url,RESTORE_DATABASE_URL:target.url,RESTORE_CONFIRM:'isolated-local-drill'};
    const result=await restoreDrill({dir:backup.directory,key,env:restoreEnv,targetConfig:{...sourceS3,bucket:'fleetchile-drill-native',credentials:{accessKeyId:'synthetic-drill',secretAccessKey:'synthetic-drill-secret'}}});
    assert.equal(result.status,'isolated-drill-verified');assert.equal(result.objects,3);
    const verify=PG.connect(PG.database(target.url),{});clients.push(verify);await verify.connect();
    for(const name of ['user_sessions','driver_tracking_sessions','driver_tracking_positions']) assert.equal((await verify.query(`select count(*)::int as n from ${name}`)).rows[0].n,0);
    for(const [name,count] of [['users',3],['telemetry',1],['audit_logs',2],['driver_mobile_actions',1],['platform_company_purge_files',1]]) assert.equal((await verify.query(`select count(*)::int as n from ${name}`)).rows[0].n,count);
    for(const [key,bytes] of objects) assert.deepEqual(buckets.get('fleetchile-drill-native').get(key),bytes);
    assert.equal(buckets.get('source-fixture-private').size,objects.size);
    console.log('PL41 native minimal fixture: real dump/restore + object readback verified');

    await t.test('esquema REAL schema.sql + 002 + startup.MIGRATION_FILES, sin iniciar app', async()=>{
      const urls=[];
      for(const [cluster,name] of [[source,'pl41_synthetic_full'],[target,'fleetchile_drill_full']]) {
        const adminURL=`postgresql://pl41_test:synthetic@127.0.0.1:${cluster.port}/postgres`, admin=PG.connect(PG.database(adminURL),{});await admin.connect();
        try {await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);}finally{await admin.end();}
        urls.push(adminURL.replace('/postgres','/'+name));
      }
      const fullCfg=PG.database(urls[0]), full=PG.connect(fullCfg,{});clients.push(full);await full.connect();
      const repo=path.join(__dirname,'..');
      await full.query(await fs.promises.readFile(path.join(repo,'schema.sql'),'utf8'));
      await full.query(await fs.promises.readFile(path.join(repo,'migrations','002_core_platform.sql'),'utf8'));
      // Reading the exported file list does not call initializeDatabase/startApplication.
      for(const migration of require('../startup').MIGRATION_FILES) await full.query(await fs.promises.readFile(path.join(repo,'migrations',migration),'utf8'));
      const sourceUserCount=(await full.query('select count(*)::int as n from users')).rows[0].n;
      const emptyStore=S3.adapter({...sourceS3,bucket:'source-fixture-empty'});let fullBackup;
      try {fullBackup=await B.createBackup({db:full,cfg:fullCfg,store:emptyStore,sourceBucket:'source-fixture-empty',root:path.join(root,'bundles'),key,tools:await PG.tools(env),env:{...env,BACKUP_OBJECTS_QUIESCED:'yes'}});}finally{emptyStore.close();}
      const fullResult=await restoreDrill({dir:fullBackup.directory,key,env:{...env,BACKUP_DATABASE_URL:urls[0],RESTORE_DATABASE_URL:urls[1],RESTORE_CONFIRM:'isolated-local-drill'},targetConfig:{...sourceS3,bucket:'fleetchile-drill-native-full',credentials:{accessKeyId:'synthetic-drill-full',secretAccessKey:'synthetic-drill-full-secret'}}});
      assert.equal(fullResult.status,'isolated-drill-verified');assert.equal(fullResult.objects,0);assert.ok(fullResult.tables>50);
      const checked=PG.connect(PG.database(urls[1]),{});clients.push(checked);await checked.connect();
      assert.ok((await checked.query('select count(*)::int as n from roles')).rows[0].n>0);
      assert.ok((await checked.query('select count(*)::int as n from geo_communes')).rows[0].n>0);
      assert.equal((await checked.query('select count(*)::int as n from users')).rows[0].n,sourceUserCount);
      console.log('PL41 native full application schema: real dump/restore + schema/content hashes verified; tables='+fullResult.tables);
    });
  });
