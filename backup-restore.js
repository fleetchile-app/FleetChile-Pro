'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PG = require('./backup-postgres');
const S3 = require('./backup-s3');
const Catalog = require('./backup-catalog');
const { verifiedStage } = require('./backup-package');
const { fail, bodyStream } = require('./backup-crypto');
const Policy = require('./backup-policy');

async function readBack(store, object) {
  const response = await store.get(object.key), hash = crypto.createHash('sha256'); let size = 0;
  for await (const chunk of bodyStream(response.Body)) { hash.update(chunk); size += chunk.length; }
  if (size !== object.size || hash.digest('hex') !== object.sha256) throw fail('RESTORE_S3_READBACK_MISMATCH');
}
async function restoreDrill({ dir, key, env = process.env, targetConfig, makeClient = PG.connect,
  makeStore = S3.adapter, tools = PG.tools, restore = PG.restore, tempRoot }) {
  if (env.RESTORE_CONFIRM !== 'isolated-local-drill') throw fail('RESTORE_CONFIRM_ISOLATED_LOCAL_DRILL_REQUIRED');
  // Authenticate every byte, version and tree BEFORE connecting to either destination.
  const stage = await verifiedStage(dir, key, { tempRoot });
  let db, store;
  try {
    const m = stage.manifest;
    const cfg = PG.assertLocalTarget(env.RESTORE_DATABASE_URL, env, m.source.database);
    const s3 = targetConfig || S3.config('RESTORE_S3_', env);
    S3.assertTarget(s3, m, env);
    const installed = await tools(env);
    if (installed.pg_restore.major !== Math.floor(m.source.serverVersion / 10000)) throw fail('RESTORE_MATCH_PG_TOOLS_TO_BACKUP_MAJOR');
    db = makeClient(cfg); await db.connect();
    const server = (await db.query("select current_setting('server_version_num')::int as version,host(inet_server_addr()) as address,(select count(*)::int from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()) as others")).rows[0];
    if (!['127.0.0.1','::1'].includes(server.address) || server.others || Math.floor(server.version / 10000) !== installed.pg_restore.major) throw fail('RESTORE_LOCAL_EXCLUSIVE_MATCHING_SERVER_REQUIRED');
    await Catalog.assertEmpty(db);
    store = makeStore(s3); await store.assertEmpty();
    // Same object keys in a separate, empty bucket; no mapping and no rewrite of business rows.
    for (const f of m.files.slice(1)) {
      await store.put(f.key, fs.createReadStream(path.join(stage.temp, f.file + '.plain')), f.size, f.contentType);
      await readBack(store, f);
    }
    // Recheck after uploads; refuse a target populated concurrently. Never DROP/CLEAN/TRUNCATE.
    await Catalog.assertEmpty(db);
    await restore(cfg, path.join(stage.temp, 'database.fcbak.enc.plain'), { env });
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      // pg_dump excludes session DATA; revoke defensively on this local target only.
      for (const name of ['driver_tracking_positions','driver_tracking_sessions','user_sessions'])
        for (const t of m.schema.tables.filter(t => t.name === name)) await db.query(`DELETE FROM ${Catalog.relation(t)}`);
      const actual = await Catalog.inventory(db);
      if (actual.schemaHash !== m.schemaHash || Catalog.hash(actual.tables) !== Catalog.hash(m.tables) ||
          Catalog.hash(actual.catalog) !== Catalog.hash(m.catalog)) throw fail('RESTORE_SCHEMA_TENANT_ACCOUNT_OR_CONTENT_MISMATCH');
      for (const t of actual.schema.tables.filter(Policy.excluded)) {
        if (Number((await db.query(`SELECT count(*)::text as count FROM ${Catalog.relation(t)}`)).rows[0].count)) throw fail('RESTORE_EPHEMERAL_SESSIONS_NOT_REVOKED');
      }
      await Catalog.validateLegacyChecks(db, actual.schema);
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; }
    return { id: m.id, status: 'isolated-drill-verified', tables: m.tables.length, objects: m.catalog.uniqueKeys, sessionsRevoked: true };
  } finally { try { await db?.end(); } finally { try { store?.close?.(); } finally { await stage.cleanup(); } } }
}
module.exports = { restoreDrill, readBack };
