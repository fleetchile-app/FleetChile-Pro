'use strict';
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { fail } = require('./backup-crypto');
function config(prefix, env = process.env) {
  const get = key => env[prefix + key];
  for (const name of ['BUCKET','REGION','ACCESS_KEY_ID','SECRET_ACCESS_KEY']) if (!get(name)) throw fail('BACKUP_S3_EXPLICIT_CONFIG_REQUIRED');
  const endpoint = get('ENDPOINT') || undefined;
  if (endpoint) {
    let url; try { url = new URL(endpoint); } catch { throw fail('BACKUP_S3_ENDPOINT_INVALID'); }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('BACKUP_S3_ENDPOINT_INVALID');
    if (url.protocol === 'http:' && !(prefix === 'RESTORE_S3_' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw fail('BACKUP_S3_HTTPS_REQUIRED');
  }
  return { bucket: get('BUCKET'), region: get('REGION'), endpoint,
    forcePathStyle: get('FORCE_PATH_STYLE') === 'true', credentials: { accessKeyId: get('ACCESS_KEY_ID'), secretAccessKey: get('SECRET_ACCESS_KEY'), ...(get('SESSION_TOKEN') ? { sessionToken: get('SESSION_TOKEN') } : {}) } };
}
function adapter(cfg) {
  // Portable S3: avoid optional AWS checksum trailers; our streams and readback use SHA-256.
  const client = new S3Client({ ...cfg, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', requestHandler: { requestTimeout: 120000, connectionTimeout: 10000 } });
  return {
    async get(key) { return client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key })); },
    async put(key, body, size, contentType) { return client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentLength: size, ContentType: contentType || 'application/octet-stream', IfNoneMatch: '*' })); },
    async assertEmpty() { const r = await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1 })); if (r.Contents?.length || r.KeyCount) throw fail('RESTORE_BUCKET_NOT_EMPTY'); },
    close() { client.destroy(); }
  };
}
function assertTarget(cfg, manifest, env = process.env) {
  if (!/^fleetchile-drill-[a-z0-9-]+$/.test(cfg.bucket)) throw fail('RESTORE_ISOLATED_BUCKET_REQUIRED');
  for (const bucket of [manifest.source.bucket, env.S3_BUCKET, env.BACKUP_SOURCE_S3_BUCKET]) if (bucket && cfg.bucket === bucket) throw fail('RESTORE_SOURCE_BUCKET_FORBIDDEN');
  for (const credential of [env.S3_ACCESS_KEY_ID, env.BACKUP_SOURCE_S3_ACCESS_KEY_ID]) if (credential && credential === cfg.credentials.accessKeyId) throw fail('RESTORE_DISTINCT_S3_CREDENTIALS_REQUIRED');
}
module.exports = { config, adapter, assertTarget };
