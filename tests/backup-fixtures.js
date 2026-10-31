'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const C = require('../backup-crypto'), PG = require('../backup-postgres'), B = require('../backup-package');
const tools = { pg_dump: { major: 18, version: 'pg_dump (PostgreSQL) 18.1' }, pg_restore: { major: 18, version: 'pg_restore (PostgreSQL) 18.1' } };
const source = PG.database('postgresql://fixture:synthetic-only@source.invalid/fleetchile');
const objects = new Map([['companies/1/pod/private', Buffer.from('synthetic pod A')], ['companies/2/consent/private', Buffer.from('synthetic private B')], ['companies/2/exports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tar.gz', Buffer.from('synthetic derived export')]]);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const sql = `CREATE TABLE companies(id integer PRIMARY KEY,name text NOT NULL);
CREATE TABLE users(id integer PRIMARY KEY,company_id integer REFERENCES companies(id),password_hash text NOT NULL);
CREATE TABLE user_sessions(id integer PRIMARY KEY,user_id integer REFERENCES users(id),token_hash text);
CREATE TABLE telemetry(id integer PRIMARY KEY,company_id integer REFERENCES companies(id),lat double precision);
CREATE TABLE driver_tracking_sessions(id integer PRIMARY KEY,auth_session_id integer REFERENCES user_sessions(id) ON DELETE CASCADE);
CREATE TABLE driver_tracking_positions(id integer PRIMARY KEY,tracking_session_id integer REFERENCES driver_tracking_sessions(id) ON DELETE CASCADE,telemetry_id integer REFERENCES telemetry(id));
CREATE TABLE audit_logs(id integer PRIMARY KEY,company_id integer REFERENCES companies(id),action text);
CREATE TABLE driver_mobile_actions(id integer PRIMARY KEY,company_id integer REFERENCES companies(id),kind text);
CREATE TABLE delivery_proof_files(id integer PRIMARY KEY,company_id integer REFERENCES companies(id),storage_key text,size integer,sha256 text);
CREATE TABLE company_export_jobs(id uuid PRIMARY KEY,company_id integer REFERENCES companies(id),status text,storage_key text,size integer,sha256 text);
CREATE TABLE platform_company_purge_files(job_id integer,storage_key text,deleted_at timestamptz);
CREATE TABLE issued_documents(id integer PRIMARY KEY,pdf bytea);
ALTER TABLE issued_documents ADD CONSTRAINT legacy_id_positive CHECK (id>0) NOT VALID;
CREATE SCHEMA vault;
CREATE TABLE vault.extra_files(id integer PRIMARY KEY,company_id integer REFERENCES companies(id),attachment_storage_key text,size integer,sha256 text);
CREATE VIEW public.account_counts AS SELECT company_id,count(*) FROM users GROUP BY company_id;
INSERT INTO companies VALUES(1,'Synthetic A'),(2,'Synthetic B');
INSERT INTO users VALUES(1,1,'synthetic hash A'),(2,2,'synthetic hash B'),(3,NULL,'synthetic platform owner');
INSERT INTO telemetry VALUES(1,1,0);
INSERT INTO audit_logs VALUES(1,1,'synthetic login audit'),(2,2,'synthetic auth audit');
INSERT INTO driver_mobile_actions VALUES(1,1,'synthetic accept');
INSERT INTO issued_documents VALUES(1,'\\x504446'::bytea);
INSERT INTO platform_company_purge_files VALUES(1,'companies/deleted/intentional','2020-01-01');
INSERT INTO delivery_proof_files VALUES(1,1,'companies/1/pod/private',${objects.get('companies/1/pod/private').length},'${sha(objects.get('companies/1/pod/private'))}');
INSERT INTO vault.extra_files VALUES(2,2,'companies/2/consent/private',${objects.get('companies/2/consent/private').length},'${sha(objects.get('companies/2/consent/private'))}');
INSERT INTO company_export_jobs VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',2,'ready',NULL,${[...objects.values()][2].length},'${sha([...objects.values()][2])}');`;
const ephemeralSQL = `INSERT INTO user_sessions VALUES(9,1,'synthetic active token'); INSERT INTO driver_tracking_sessions VALUES(5,9); INSERT INTO driver_tracking_positions VALUES(6,5,1);`;
function database(db) {
  const log = [];
  return { log, async connect() {}, async end() {}, async query(text, args) {
    log.push(text);
    if (text.includes('pg_export_snapshot()')) return { rows: [{ snapshot: '00000001-00000002-1', snapshot_at: '2026-10-31T00:00:00Z', server_version: 180001 }] };
    if (text.includes('inet_server_addr()')) return { rows: [{ version: 180001, address: '127.0.0.1', others: 0 }] };
    return db.query(text, args);
  } };
}
async function fixture(t) {
  const { PGlite } = require(process.env.FLEETCHILE_TEST_PGLITE);
  const db = new PGlite(); await db.exec(sql + ephemeralSQL);
  const root = await C.tempDir(os.tmpdir(), 'pl41-test-'), key = crypto.randomBytes(32), client = database(db);
  const sourceObjects = new Map(objects), calls = [];
  const store = { async get(key) { calls.push(key); if (!sourceObjects.has(key)) throw Error('synthetic missing'); const b = sourceObjects.get(key); return { Body: Readable.from([b]), ContentLength: b.length, VersionId: 'synthetic-v1', LastModified: new Date('2020-01-01') }; } };
  const dump = async (cfg, snapshot, consume) => {
    if (snapshot !== '00000001-00000002-1' || !client.log[0].startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ')) throw Error('snapshot contract broken');
    return consume(Readable.from([Buffer.from('PGDMP' + sql)])); // Explicit synthetic transport, not a native archive.
  };
  t.after(async () => { await db.close(); key.fill(0); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('pl41-test-')) throw Error('unsafe test cleanup'); await fs.promises.rm(root, { recursive: true, force: true }); });
  return { root, key, db, client, store, sourceObjects, calls, dump, tools,
    async backup() { return B.createBackup({ db: client, cfg: source, store, sourceBucket: 'source-fixture-private', root, key, tools, env: { BACKUP_OBJECTS_QUIESCED: 'yes' }, dump }); } };
}
async function rewriteManifest(bundle, key, mutate) {
  const stage = await B.verifiedStage(bundle, key);
  try {
    mutate(stage.manifest);
    const replacement = path.join(stage.temp, 'replacement.fcbak.enc');
    const sealed = await C.seal(Readable.from([Buffer.from(JSON.stringify(stage.manifest))]), replacement, key);
    await fs.promises.copyFile(replacement, path.join(bundle, 'manifest.fcbak.enc'));
    const readyFile = path.join(bundle, 'READY.json'), ready = JSON.parse(await fs.promises.readFile(readyFile, 'utf8'));
    ready.manifest = sealed.encrypted; await fs.promises.writeFile(readyFile, JSON.stringify(ready));
  } finally { await stage.cleanup(); }
}
module.exports = { fixture, rewriteManifest, database, sql, ephemeralSQL, tools, source, objects };
