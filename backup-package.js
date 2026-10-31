'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const C = require('./backup-crypto');
const PG = require('./backup-postgres');
const Catalog = require('./backup-catalog');
const Policy = require('./backup-policy');
const FORMAT = 'fleetchile-integral-backup';
const VERSION = 1;
const MAX_MANIFEST = 16 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
async function rootDirectory(root) {
  if (!path.isAbsolute(root)) throw C.fail('BACKUP_ABSOLUTE_ROOT_REQUIRED');
  try { await C.privateDir(root); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const stat = await fs.promises.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.mode & 0o077)) throw C.fail('BACKUP_PRIVATE_ROOT_REQUIRED');
  // Each artifact directory has its own private ACL even when the root already exists.
  return fs.promises.realpath(root);
}
async function createBackup({ db, cfg, store, sourceBucket, root, key, tools, env = process.env, dump = PG.dump }) {
  if (env.BACKUP_OBJECTS_QUIESCED !== 'yes') throw C.fail('BACKUP_PAUSE_OBJECT_MUTATIONS_AND_GC_REQUIRED');
  root = await rootDirectory(root);
  const id = crypto.randomUUID(), dir = await C.privateDir(path.join(root, 'pl41-' + id));
  let transaction = false;
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    await db.query('SET LOCAL row_security = off');
    const info = (await db.query("select pg_export_snapshot() as snapshot,statement_timestamp()::text as snapshot_at,current_setting('server_version_num')::int as server_version,current_database() as database")).rows[0];
    if (Math.floor(info.server_version / 10000) !== tools.pg_dump.major) throw C.fail('BACKUP_MATCH_PG_TOOLS_TO_SERVER_MAJOR');
    const state = await Catalog.inventory(db);
    const files = [];
    const data = await dump(cfg, info.snapshot, body => C.seal(body, path.join(dir, 'database.fcbak.enc'), key), { env });
    files.push({ file: 'database.fcbak.enc', kind: 'postgres-custom', ...data });
    for (let i = 0; i < state.catalog.objects.length; i++) {
      const object = state.catalog.objects[i];
      let response; try { response = await store.get(object.key); } catch { throw C.fail('BACKUP_REFERENCED_OBJECT_MISSING_RETRY'); }
      if (!response?.Body) throw C.fail('BACKUP_REFERENCED_OBJECT_MISSING_RETRY');
      // Immutable objects uploaded before the DB reference; fail on a post-snapshot overwrite.
      if (response.LastModified && new Date(response.LastModified).getTime() > new Date(info.snapshot_at).getTime()) {
        response.Body.destroy?.(); throw C.fail('BACKUP_OBJECT_CHANGED_AFTER_SNAPSHOT_RETRY');
      }
      const file = `object-${i}.fcbak.enc`;
      const sealed = await C.seal(response.Body, path.join(dir, file), key);
      if (response.ContentLength != null && Number(response.ContentLength) !== sealed.size) throw C.fail('BACKUP_OBJECT_SIZE_MISMATCH');
      for (const ref of object.references) {
        if (ref.size != null && ref.size !== sealed.size || ref.sha256 && ref.sha256.toLowerCase() !== sealed.sha256) throw C.fail('BACKUP_OBJECT_REFERENCE_HASH_MISMATCH');
      }
      files.push({ file, kind: 's3-object', key: object.key, versionId: response.VersionId || null, etag: response.ETag || null,
        lastModified: response.LastModified ? new Date(response.LastModified).toISOString() : null, contentType: response.ContentType || 'application/octet-stream', ...sealed });
    }
    await db.query('COMMIT'); transaction = false;
    const manifest = { format: FORMAT, version: VERSION, id, createdAt: new Date().toISOString(), snapshotAt: info.snapshot_at,
      source: { database: PG.identity(cfg), bucket: sourceBucket, serverVersion: info.server_version },
      applicationVersion: require('./package.json').version, pgTools: tools, cipher: 'AES-256-GCM',
      sessionPolicy: 'user_sessions-data-excluded-revoke-on-drill', objectPolicy: 'all-live-catalog-storage-keys-plus-derived-exportKey-confirmed-purge-tombstones-audited',
      ...state, files };
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > MAX_MANIFEST) throw C.fail('BACKUP_MANIFEST_LIMIT');
    const sealedManifest = await C.seal(Readable.from([bytes]), path.join(dir, 'manifest.fcbak.enc'), key);
    // Publication marker is last. A partial directory is never a usable backup.
    await fs.promises.writeFile(path.join(dir, 'READY.json'), JSON.stringify({ format: FORMAT, version: VERSION, id, manifest: sealedManifest.encrypted }), { flag: 'wx', mode: 0o600 });
    return { id, directory: dir, objects: state.catalog.uniqueKeys, tables: state.tables.length };
  } catch (e) {
    if (transaction) try { await db.query('ROLLBACK'); } catch {}
    // Keep failed encrypted artifacts for diagnosis; no READY, no source delete, no cleanup outside ownership.
    throw e;
  }
}
function validateManifest(m, ready, dir) {
  if (m.format !== FORMAT || m.version !== VERSION || ready.format !== FORMAT || ready.version !== VERSION ||
      !uuid.test(m.id || '') || ready.id !== m.id || path.basename(dir) !== 'pl41-' + m.id || m.cipher !== 'AES-256-GCM' ||
      m.sessionPolicy !== 'user_sessions-data-excluded-revoke-on-drill' || !m.source?.database || !m.source?.bucket ||
      !Number.isInteger(m.source.serverVersion) || !Array.isArray(m.files) || !m.files.length || !Array.isArray(m.tables) ||
      !m.schema || Catalog.hash(m.schema) !== m.schemaHash || !same(m.excludedEphemeral, Policy.exclusions(m.schema.tables)) || !Array.isArray(m.catalog?.objects) || !Array.isArray(m.catalog?.columns)) throw C.fail('BACKUP_MANIFEST_INVALID_OR_VERSION');
  const names = new Set(), keys = new Set();
  for (let i = 0; i < m.files.length; i++) {
    const f = m.files[i];
    if (f.file !== (i === 0 ? 'database.fcbak.enc' : `object-${i-1}.fcbak.enc`) || names.has(f.file) ||
        f.kind !== (i === 0 ? 'postgres-custom' : 's3-object') || !Number.isSafeInteger(f.size) || f.size < 0 ||
        !/^[a-f0-9]{64}$/.test(f.sha256) || !/^[a-f0-9]{64}$/.test(f.encrypted?.sha256) || f.encrypted.size !== f.size + 36) throw C.fail('BACKUP_MANIFEST_FILE_INVALID');
    names.add(f.file);
    if (i) { if (typeof f.key !== 'string' || !f.key || keys.has(f.key)) throw C.fail('BACKUP_MANIFEST_KEY_INVALID'); keys.add(f.key); }
  }
  if (m.catalog.uniqueKeys !== keys.size || !same(m.catalog.objects.map(o => o.key), m.files.slice(1).map(f => f.key)) ||
      m.catalog.referenceCount !== m.catalog.columns.reduce((n,c) => n + c.references, 0)) throw C.fail('BACKUP_CATALOG_INCOMPLETE');
}
async function inspectBundle(dir, key, temp) {
  const stat = await fs.promises.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw C.fail('BACKUP_DIRECTORY_INVALID');
  const readyFile = await C.regularFile(dir, 'READY.json');
  if ((await fs.promises.stat(readyFile)).size > 4096) throw C.fail('BACKUP_READY_INVALID');
  const ready = JSON.parse(await fs.promises.readFile(readyFile, 'utf8'));
  const encrypted = await C.regularFile(dir, 'manifest.fcbak.enc');
  const statManifest = await fs.promises.stat(encrypted);
  if (statManifest.size > MAX_MANIFEST + 36 || !same(await C.digest(encrypted), ready.manifest)) throw C.fail('BACKUP_MANIFEST_HASH_MISMATCH');
  const plain = path.join(temp, 'manifest.json');
  await C.unseal(encrypted, plain, key);
  const m = JSON.parse(await fs.promises.readFile(plain, 'utf8'));
  validateManifest(m, ready, dir);
  const expected = ['READY.json','manifest.fcbak.enc', ...m.files.map(f => f.file)].sort();
  if (!same((await fs.promises.readdir(dir)).sort(), expected)) throw C.fail('BACKUP_TREE_MISMATCH');
  for (const f of m.files) {
    const file = await C.regularFile(dir, f.file);
    if (!same(await C.digest(file), f.encrypted)) throw C.fail('BACKUP_FILE_HASH_MISMATCH');
  }
  return m;
}
async function verifiedStage(dir, key, { tempRoot = os.tmpdir() } = {}) {
  const temp = await C.tempDir(tempRoot, 'pl41-verify-');
  try {
    const manifest = await inspectBundle(dir, key, temp);
    for (const f of manifest.files) await C.unseal(await C.regularFile(dir, f.file), path.join(temp, f.file + '.plain'), key, f);
    const h = await fs.promises.open(path.join(temp, 'database.fcbak.enc.plain'), 'r');
    const magic = Buffer.alloc(5); try { await h.read(magic, 0, 5, 0); } finally { await h.close(); }
    if (magic.toString() !== 'PGDMP') throw C.fail('BACKUP_NOT_POSTGRES_CUSTOM');
    return { manifest, temp, cleanup: () => fs.promises.rm(temp, { recursive: true, force: true }) };
  } catch (e) { await fs.promises.rm(temp, { recursive: true, force: true }); throw e; }
}
async function retain({ root, key, days, keep = 1, apply = false, now = Date.now() }) {
  if (!apply || !Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(keep) || keep < 1) throw C.fail('BACKUP_RETENTION_EXPLICIT_APPLY_DAYS_KEEP_REQUIRED');
  root = await fs.promises.realpath(root);
  const verified = [];
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('pl41-') || !uuid.test(entry.name.slice(5))) continue;
    const dir = path.join(root, entry.name);
    // Authenticate and check the complete owned tree before any removal; abort on partial/tampered backups.
    const stage = await verifiedStage(dir, key);
    try { verified.push({ dir, time: Date.parse(stage.manifest.createdAt) }); } finally { await stage.cleanup(); }
  }
  verified.sort((a,b) => b.time - a.time);
  let removed = 0;
  for (const b of verified.slice(keep)) if (Number.isFinite(b.time) && b.time < now - days * 86400000) {
    if (path.dirname(b.dir) !== root) throw C.fail('BACKUP_RETENTION_SCOPE');
    await fs.promises.rm(b.dir, { recursive: true }); removed++;
  }
  return { removed };
}
module.exports = { FORMAT, VERSION, createBackup, inspectBundle, verifiedStage, validateManifest, retain, rootDirectory };
