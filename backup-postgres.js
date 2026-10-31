'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { fail, tempDir } = require('./backup-crypto');
const { EPHEMERAL } = require('./backup-policy');

function database(value) {
  let url; try { url = new URL(value); } catch { throw fail('BACKUP_DATABASE_URL_REQUIRED'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.hash) throw fail('BACKUP_DATABASE_URL_INVALID');
  const params = [...url.searchParams];
  if (params.some(([k,v]) => k !== 'sslmode' || !['disable','verify-full'].includes(v)) || params.length > 1) throw fail('BACKUP_DATABASE_REQUIRE_VERIFY_FULL_OR_LOCAL_DISABLE');
  const cfg = { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || '5432',
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), name: decodeURIComponent(url.pathname.slice(1)), sslmode: url.searchParams.get('sslmode') || (['localhost','127.0.0.1','[::1]'].includes(url.hostname) ? 'disable' : 'verify-full') };
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(cfg.name) || Object.values(cfg).some(v => /[\r\n\0]/.test(v))) throw fail('BACKUP_DATABASE_URL_INVALID');
  if (cfg.sslmode === 'disable' && !['localhost','127.0.0.1','::1'].includes(cfg.host)) throw fail('BACKUP_EXTERNAL_DATABASE_TLS_REQUIRED');
  return cfg;
}
const identity = c => `${c.host.toLowerCase()}:${c.port}/${c.name}`;
function assertLocalTarget(value, env = process.env, source) {
  const cfg = database(value);
  if (!['localhost','127.0.0.1','::1'].includes(cfg.host) || !/^fleetchile_drill_[a-z0-9_]{1,60}$/.test(cfg.name) || cfg.sslmode !== 'disable') throw fail('RESTORE_LOCAL_DISPOSABLE_DATABASE_REQUIRED');
  for (const candidate of [env.DATABASE_URL, env.BACKUP_DATABASE_URL]) {
    if (!candidate) continue;
    const other = database(candidate);
    // Refuse even a different database on an application's local server.
    if (['localhost','127.0.0.1','::1'].includes(other.host) && other.port === cfg.port) throw fail('RESTORE_APPLICATION_SERVER_FORBIDDEN');
    if (identity(other) === identity(cfg)) throw fail('RESTORE_SOURCE_DATABASE_FORBIDDEN');
  }
  if (source && (source === identity(cfg) || /^(localhost|127\.0\.0\.1|::1):/.test(source) && source.split('/')[0].endsWith(':' + cfg.port))) throw fail('RESTORE_SOURCE_DATABASE_FORBIDDEN');
  return cfg;
}
function connect(cfg, env = process.env) {
  return new Client({ host: cfg.host, port: Number(cfg.port), user: cfg.user, password: cfg.password, database: cfg.name,
    ssl: cfg.sslmode === 'disable' ? false : { rejectUnauthorized: true, ...(env.BACKUP_PG_SSLROOTCERT ? { ca: fs.readFileSync(env.BACKUP_PG_SSLROOTCERT, 'utf8') } : {}) }, connectionTimeoutMillis: 10000, statement_timeout: 120000 });
}
function toolPath(name, env = process.env) { return env.BACKUP_PG_BIN ? path.join(env.BACKUP_PG_BIN, name + (process.platform === 'win32' ? '.exe' : '')) : name; }
function childEnv(env = process.env) {
  // No DATABASE_URL, PGPASSWORD, service config, S3 credentials or encryption keys inherited.
  const clean = {};
  for (const name of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','APPDATA','LANG']) if (env[name]) clean[name] = env[name];
  return clean;
}
async function run(name, args, { env = process.env, pgEnv = {}, consume } = {}) {
  const child = spawn(toolPath(name, env), args, { env: { ...childEnv(env), ...pgEnv }, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  child.stderr.resume(); // libpq stderr can contain connection details; never log it.
  const done = new Promise((resolve, reject) => {
    child.once('error', () => reject(fail('BACKUP_PG_TOOL_UNAVAILABLE')));
    child.once('close', code => code === 0 ? resolve() : reject(fail('BACKUP_PG_TOOL_FAILED')));
  });
  let timeout;
  try {
    timeout = setTimeout(() => child.kill(), 60 * 60 * 1000); timeout.unref();
    return await Promise.all([done, consume ? consume(child.stdout) : (async () => { let result = ''; for await (const b of child.stdout) { result += b.toString(); if (result.length > 65536) throw fail('BACKUP_PG_TOOL_OUTPUT_LIMIT'); } return result; })()]).then(r => r[1]);
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
}
async function credentials(cfg, callback, { parent = os.tmpdir(), env = process.env } = {}) {
  const dir = await tempDir(parent, 'pl41-pgpass-'), file = path.join(dir, 'pgpass');
  const escape = s => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  const terminate = status => () => { fs.promises.rm(dir, { recursive: true, force: true }).finally(() => process.exit(status)); };
  const onTerm=terminate(143), onInt=terminate(130);
  process.once('SIGTERM',onTerm); process.once('SIGINT',onInt);
  try {
    await fs.promises.writeFile(file, [cfg.host,cfg.port,cfg.name,cfg.user,cfg.password].map(escape).join(':') + '\n', { flag: 'wx', mode: 0o600 });
    return await callback({ PGPASSFILE: file, PGSSLMODE: cfg.sslmode, PGCONNECT_TIMEOUT: '10', ...(env.BACKUP_PG_SSLROOTCERT ? { PGSSLROOTCERT: env.BACKUP_PG_SSLROOTCERT } : {}) });
  } finally { process.removeListener('SIGTERM',onTerm); process.removeListener('SIGINT',onInt); await fs.promises.rm(dir, { recursive: true, force: true }); }
}
const connectionArgs = cfg => [`--host=${cfg.host}`, `--port=${cfg.port}`, `--username=${cfg.user}`, `--dbname=${cfg.name}`, '--no-password'];
async function tools(env = process.env) {
  const versions = {};
  for (const name of ['pg_dump','pg_restore']) {
    let output;
    try { output = await run(name, ['--version'], { env }); } catch { throw fail('BACKUP_INSTALL_PG_TOOLS_SET_BACKUP_PG_BIN'); }
    const match = output.match(/\(PostgreSQL\)\s+(\d+)(?:\.\d+)+/);
    if (!match) throw fail('BACKUP_PG_TOOL_VERSION_UNKNOWN');
    versions[name] = { major: Number(match[1]), version: output.trim() };
  }
  if (versions.pg_dump.major !== versions.pg_restore.major) throw fail('BACKUP_PG_TOOLS_MAJOR_MISMATCH');
  return versions;
}
async function dump(cfg, snapshot, consume, { env = process.env, runTool = run } = {}) {
  if (!/^[0-9a-f-]+$/i.test(snapshot)) throw fail('BACKUP_SNAPSHOT_INVALID');
  return credentials(cfg, pgEnv => runTool('pg_dump', [...connectionArgs(cfg), '--format=custom', '--no-owner', '--no-acl', '--snapshot=' + snapshot, ...Object.keys(EPHEMERAL).map(t => '--exclude-table-data=*.' + t)], { env, pgEnv, consume }), { env });
}
async function restore(cfg, file, { env = process.env } = {}) {
  return credentials(cfg, pgEnv => run('pg_restore', [...connectionArgs(cfg), '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', file], { env, pgEnv }), { env });
}
module.exports = { database, identity, assertLocalTarget, connect, tools, dump, restore, credentials, connectionArgs, childEnv };
