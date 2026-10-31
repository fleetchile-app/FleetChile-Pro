#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const C = require('../backup-crypto');
const PG = require('../backup-postgres');
const S3 = require('../backup-s3');
const B = require('../backup-package');

async function secrets(env = process.env) {
  const out = { ...env };
  for (const name of ['BACKUP_DATABASE_URL','RESTORE_DATABASE_URL', ...['BACKUP_SOURCE_S3_','RESTORE_S3_'].flatMap(p => ['ACCESS_KEY_ID','SECRET_ACCESS_KEY','SESSION_TOKEN'].map(k => p + k))]) {
    if (!env[name + '_FILE']) continue;
    if (env[name]) throw C.fail('BACKUP_SECRET_VALUE_AND_FILE_CONFLICT');
    const file = env[name + '_FILE'];
    if (!path.isAbsolute(file) || (await fs.promises.stat(file)).size > 16384) throw C.fail('BACKUP_SECRET_FILE_INVALID');
    out[name] = (await fs.promises.readFile(file, 'utf8')).trim();
  }
  return out;
}
async function doctor(env = process.env) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw C.fail('BACKUP_NODE_20_REQUIRED');
  const installed = await PG.tools(env);
  return { status: 'tools-available-only-no-source-contact', node: process.versions.node, tools: installed };
}
async function main(args = process.argv.slice(2), initial = process.env) {
  const [command = 'doctor', ...extra] = args;
  if (command === 'doctor' && !extra.length) return doctor(initial);
  if (command === '--help') return { usage: 'node scripts/backup.js doctor | create | verify <absolute-bundle-dir> | retain --apply; node scripts/restore.js <absolute-bundle-dir>. Configure explicit environment; see docs/RESPALDO_RESTAURACION.md.' };
  if (!['create','verify','retain'].includes(command) || command === 'create' && extra.length || command === 'verify' && (extra.length !== 1 || !path.isAbsolute(extra[0])) || command === 'retain' && (extra.length !== 1 || extra[0] !== '--apply')) throw C.fail('BACKUP_USAGE_SEE_HELP');
  if (command === 'create') await doctor(initial); // No secret read or connection when tools are absent.
  const env = await secrets(initial), key = await C.keyFromFile(env.BACKUP_KEY_FILE);
  let db, store;
  try {
    if (command === 'verify') {
      const stage = await B.verifiedStage(extra[0], key);
      try { return { status: 'authenticated-bundle-only-not-a-restore', id: stage.manifest.id, objects: stage.manifest.catalog.uniqueKeys }; } finally { await stage.cleanup(); }
    }
    if (command === 'retain') {
      if (!env.BACKUP_ROOT) throw C.fail('BACKUP_ABSOLUTE_ROOT_REQUIRED');
      return await B.retain({ root: env.BACKUP_ROOT, key, days: Number(env.BACKUP_RETENTION_DAYS), keep: Number(env.BACKUP_RETENTION_KEEP || 1), apply: true });
    }
    if (!env.BACKUP_ROOT || env.BACKUP_OBJECTS_QUIESCED !== 'yes') throw C.fail('BACKUP_ROOT_AND_QUIESCED_OBJECTS_REQUIRED');
    const cfg = PG.database(env.BACKUP_DATABASE_URL), s3 = S3.config('BACKUP_SOURCE_S3_', env);
    db = PG.connect(cfg, env); await db.connect(); store = S3.adapter(s3);
    const result = await B.createBackup({ db, cfg, store, sourceBucket: s3.bucket, root: env.BACKUP_ROOT, key, tools: await PG.tools(env), env });
    return { status: 'backup-ready', id: result.id, tables: result.tables, objects: result.objects };
  } finally { key.fill(0); try { await db?.end(); } finally { store?.close(); } }
}
function reportError(error) {
  const code = /^BACKUP_[A-Z0-9_]+$|^RESTORE_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'BACKUP_FAILED_NO_READY';
  console.error(code);
  if (code === 'BACKUP_INSTALL_PG_TOOLS_SET_BACKUP_PG_BIN') console.error('Instala pg_dump y pg_restore de la misma versión mayor que PostgreSQL, o configura BACKUP_PG_BIN con su directorio bin. En Windows revisa C:/Program Files/PostgreSQL/<version>/bin o D:/PostgreSQL/<version>/bin. No se contactó ninguna base.');
  process.exitCode = 1;
}
if (require.main === module) main().then(r => console.log(JSON.stringify(r))).catch(reportError);
module.exports = { main, doctor, secrets, reportError };
