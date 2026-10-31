'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const MAGIC = Buffer.from('FCPL41G1');
const fail = code => Object.assign(new Error(code), { code });
const bodyStream = body => Buffer.isBuffer(body) || body instanceof Uint8Array ? Readable.from([body]) : body?.getReader ? Readable.fromWeb(body) : body;

async function privateDir(dir) {
  await fs.promises.mkdir(dir, { mode: 0o700 }); // Must be a new directory, never relax an existing ACL.
  if (process.platform === 'win32') {
    const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
    const sid = stdout.match(/S-1-5-[0-9-]+/)?.[0];
    if (!sid) throw fail('BACKUP_PRIVATE_ACL_FAILED');
    await exec('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
  }
  return dir;
}
async function tempDir(parent, prefix) {
  const dir = path.join(parent, prefix + crypto.randomUUID());
  return privateDir(dir);
}
async function keyFromFile(file) {
  if (!file || !path.isAbsolute(file)) throw fail('BACKUP_KEY_FILE_REQUIRED');
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw fail('BACKUP_KEY_FILE_INVALID');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw fail('BACKUP_KEY_FILE_PERMISSIONS');
  const bytes = await fs.promises.readFile(file);
  const key = bytes.length === 32 ? Buffer.from(bytes) : /^[a-f0-9]{64}$/i.test(bytes.toString().trim()) ? Buffer.from(bytes.toString().trim(), 'hex') : null;
  bytes.fill(0);
  if (!key) throw fail('BACKUP_KEY_FILE_INVALID');
  return key;
}
async function digest(file) {
  const hash = crypto.createHash('sha256'); let size = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { size, sha256: hash.digest('hex') };
}
async function seal(body, file, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const hash = crypto.createHash('sha256'); let size = 0;
  const meter = new Transform({ transform(chunk, enc, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } });
  const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
  out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(bodyStream(body), meter, cipher, out);
  await fs.promises.appendFile(file, cipher.getAuthTag());
  return { size, sha256: hash.digest('hex'), encrypted: await digest(file) };
}
async function unseal(file, output, key, expected) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 36) throw fail('BACKUP_ENVELOPE_INVALID');
  const h = await fs.promises.open(file, 'r');
  const header = Buffer.alloc(20), tag = Buffer.alloc(16);
  try { await h.read(header, 0, 20, 0); await h.read(tag, 0, 16, stat.size - 16); } finally { await h.close(); }
  if (!header.subarray(0, 8).equals(MAGIC)) throw fail('BACKUP_ENVELOPE_VERSION');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(8));
  decipher.setAAD(MAGIC); decipher.setAuthTag(tag);
  const hash = crypto.createHash('sha256'); let size = 0;
  const meter = new Transform({ transform(chunk, enc, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } });
  try {
    await pipeline(stat.size === 36 ? Readable.from([]) : fs.createReadStream(file, { start: 20, end: stat.size - 17 }), decipher, meter,
      fs.createWriteStream(output, { flags: 'wx', mode: 0o600 }));
    const actual = { size, sha256: hash.digest('hex') };
    if (expected && (actual.size !== expected.size || actual.sha256 !== expected.sha256)) throw fail('BACKUP_HASH_MISMATCH');
    return actual;
  } catch { await fs.promises.rm(output, { force: true }); throw fail('BACKUP_AUTH_OR_HASH_FAILED'); }
}
async function regularFile(dir, name) {
  if (!/^[a-zA-Z0-9.-]+$/.test(name) || name.includes('..')) throw fail('BACKUP_PATH_INVALID');
  const file = path.join(dir, name), stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('BACKUP_PATH_INVALID');
  return file;
}
module.exports = { fail, privateDir, tempDir, keyFromFile, digest, seal, unseal, regularFile, bodyStream };
