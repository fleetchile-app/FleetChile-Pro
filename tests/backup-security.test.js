'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const C = require('../backup-crypto'), PG = require('../backup-postgres'), S3 = require('../backup-s3');
const { scheduleConfig } = require('../scripts/backup-runner'), { doctor, secrets } = require('../scripts/backup');
async function temp(t) {
  const dir = await C.tempDir(os.tmpdir(), 'pl41-unit-');
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); await fs.promises.rm(dir, { recursive: true, force: true }); }); return dir;
}
test('AES256GCM streaming, nonce independiente, empty, hash, corrupción, clave incorrecta', async t => {
  const dir = await temp(t), key = crypto.randomBytes(32), wrong = crypto.randomBytes(32);
  for (const [i, bytes] of [Buffer.alloc(0),crypto.randomBytes(2*1024*1024)].entries()) {
    const file = path.join(dir, `sealed-${i}`), file2 = path.join(dir, `sealed2-${i}`), out = path.join(dir, `out-${i}`);
    const record = await C.seal(Readable.from([bytes.subarray(0,17),bytes.subarray(17)]), file, key);
    await C.seal(Readable.from([bytes]), file2, key);
    assert.notDeepEqual((await fs.promises.readFile(file)).subarray(8,20), (await fs.promises.readFile(file2)).subarray(8,20));
    assert.equal(record.encrypted.size, bytes.length + 36); await C.unseal(file, out, key, record);
    assert.deepEqual(await fs.promises.readFile(out), bytes);
    await assert.rejects(C.unseal(file, path.join(dir, `wrong-${i}`), wrong), /BACKUP_AUTH_OR_HASH_FAILED/);
    const corrupt = await fs.promises.readFile(file); corrupt[corrupt.length-1] ^= 1; await fs.promises.writeFile(file, corrupt);
    await assert.rejects(C.unseal(file, path.join(dir, `bad-${i}`), key), /BACKUP_AUTH_OR_HASH_FAILED/);
    assert.equal(fs.existsSync(path.join(dir, `bad-${i}`)), false);
  }
});
test('fuente externa TLS verify-full por defecto; rechaza downgrade y opciones libpq inyectadas', () => {
  assert.equal(PG.database('postgres://u:p@source.invalid/database').sslmode, 'verify-full');
  assert.equal(PG.database('postgres://u:p@127.0.0.1/database').sslmode, 'disable');
  assert.throws(() => PG.database('postgres://u:p@source.invalid/database?sslmode=disable'), /TLS_REQUIRED/);
  assert.throws(() => PG.database('postgres://u:p@source.invalid/database?sslmode=require'), /VERIFY_FULL/);
  assert.throws(() => PG.database('postgres://u:p@source.invalid/db?host=other'), /VERIFY_FULL/);
  assert.throws(() => PG.database('postgres://u:p@127.0.0.1/host%3Dprod'), /URL_INVALID/);
  assert.throws(() => PG.database(undefined), /URL_REQUIRED/);
});
test('PGPASSFILE privado temporal, escape, CA explícita, nunca password en argv ni env heredado', async t => {
  const cfg = PG.database('postgres://user:p%3Aa%5Css@127.0.0.1/synthetic'), env = { BACKUP_PG_SSLROOTCERT: '/safe/root-ca.pem' };
  let passfile;
  const result = await PG.dump(cfg, '00000001-00000002-1', body => { body.resume(); return 'synthetic'; }, { env,
    async runTool(name, args, opts) {
      assert.equal(name, 'pg_dump'); assert.ok(args.includes('--snapshot=00000001-00000002-1'));
      for (const table of ['user_sessions','driver_tracking_sessions','driver_tracking_positions']) assert.ok(args.includes('--exclude-table-data=*.' + table));
      assert.ok(!args.some(v => /password=|p:a/.test(v))); assert.equal(opts.pgEnv.PGSSLROOTCERT, '/safe/root-ca.pem');
      passfile = opts.pgEnv.PGPASSFILE; assert.match(await fs.promises.readFile(passfile, 'utf8'), /p\\:a\\\\ss/);
      return opts.consume(Readable.from(['PGDMP-synthetic']));
    } });
  assert.equal(result, 'synthetic'); assert.equal(fs.existsSync(passfile), false);
  assert.deepEqual(PG.childEnv({ PATH: '/bin', PGPASSWORD: 'private', DATABASE_URL: 'private', S3_SECRET_ACCESS_KEY: 'private', BACKUP_KEY_FILE: 'private' }), { PATH: '/bin' });
  await assert.rejects(PG.credentials(cfg, async e => { passfile=e.PGPASSFILE; throw Error('synthetic'); }), /synthetic/);
  assert.equal(fs.existsSync(passfile), false);
});
test('restauración exige local desechable y servidor distinto al de aplicación/origen', () => {
  const target = 'postgres://test:synthetic@127.0.0.1:55441/fleetchile_drill_test';
  assert.equal(PG.assertLocalTarget(target, {}).name, 'fleetchile_drill_test');
  for (const value of ['postgres://u:p@prod.invalid/fleetchile_drill_test','postgres://u:p@127.0.0.1/postgres','postgres://u:p@127.0.0.1/fleetchile']) assert.throws(() => PG.assertLocalTarget(value, {}), /LOCAL_DISPOSABLE/);
  assert.throws(() => PG.assertLocalTarget(target, { DATABASE_URL: 'postgres://app:p@localhost:55441/another' }), /APPLICATION_SERVER/);
  assert.throws(() => PG.assertLocalTarget(target, {}, 'localhost:55441/source'), /SOURCE_DATABASE/);
});
test('S3 requiere HTTPS externo y destino privado independiente con credenciales diferentes', () => {
  const source = { BACKUP_SOURCE_S3_REGION: 'test', BACKUP_SOURCE_S3_BUCKET: 'private', BACKUP_SOURCE_S3_ACCESS_KEY_ID: 'fake', BACKUP_SOURCE_S3_SECRET_ACCESS_KEY: 'synthetic' };
  assert.throws(() => S3.config('BACKUP_SOURCE_S3_', { ...source, BACKUP_SOURCE_S3_ENDPOINT: 'http://127.0.0.1:9000' }), /HTTPS_REQUIRED/);
  const env = Object.fromEntries(Object.entries(source).map(([k,v]) => [k.replace('BACKUP_SOURCE_S3_','RESTORE_S3_'),v]));
  assert.equal(S3.config('RESTORE_S3_', { ...env, RESTORE_S3_ENDPOINT: 'http://127.0.0.1:9000' }).endpoint, 'http://127.0.0.1:9000');
  assert.throws(() => S3.config('RESTORE_S3_', { ...env, RESTORE_S3_ENDPOINT: 'http://external.invalid' }), /HTTPS_REQUIRED/);
  const cfg = { bucket: 'fleetchile-drill-test', credentials: { accessKeyId: 'drill' } }, m = { source: { bucket: 'private' } };
  S3.assertTarget(cfg, m, {});
  assert.throws(() => S3.assertTarget(cfg, m, { S3_BUCKET: cfg.bucket }), /SOURCE_BUCKET/);
  assert.throws(() => S3.assertTarget(cfg, m, { BACKUP_SOURCE_S3_ACCESS_KEY_ID: 'drill' }), /DISTINCT_S3/);
});
test('scheduling doble opt-in y límites; doctor falla actionable sin ejecutar conexión', async t => {
  assert.throws(() => scheduleConfig({}), /EXPLICIT_ENABLE/);
  assert.throws(() => scheduleConfig({ BACKUP_SCHEDULE_ENABLED: 'yes', BACKUP_INTERVAL_SECONDS: '1' }), /INTERVAL/);
  assert.equal(scheduleConfig({ BACKUP_SCHEDULE_ENABLED: 'yes' }), 86400000);
  const dir = await temp(t);
  await assert.rejects(doctor({ BACKUP_PG_BIN: dir }), /INSTALL_PG_TOOLS_SET_BACKUP_PG_BIN/);
});
test('key sólo archivo, tamaño exacto; secretos _FILE sin imprimirlos', async t => {
  const dir = await temp(t), file = path.join(dir, 'key'), key = crypto.randomBytes(32);
  await fs.promises.writeFile(file,key,{mode:0o600}); assert.deepEqual(await C.keyFromFile(file), key);
  await assert.rejects(C.keyFromFile('relative.key'), /KEY_FILE_REQUIRED/);
  await fs.promises.writeFile(file,'wrong'); await assert.rejects(C.keyFromFile(file), /KEY_FILE_INVALID/);
  await fs.promises.writeFile(file,'synthetic-secret');
  const result = await secrets({ BACKUP_DATABASE_URL_FILE: file }); assert.equal(result.BACKUP_DATABASE_URL,'synthetic-secret');
  await assert.rejects(secrets({ BACKUP_DATABASE_URL_FILE: file, BACKUP_DATABASE_URL: 'also-set' }), /CONFLICT/);
});
