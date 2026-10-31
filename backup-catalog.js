'use strict';
const crypto = require('node:crypto');
const { fail } = require('./backup-crypto');
const Policy = require('./backup-policy');
const quote = s => '"' + s.replaceAll('"', '""') + '"';
const relation = t => quote(t.schema) + '.' + quote(t.name);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const storageColumn = name => name === 'storage_key' || name.endsWith('_storage_key');

async function metadata(db) {
  const tables = (await db.query(`select n.nspname as schema,c.relname as name,c.relkind as kind,c.relrowsecurity as rls,c.relforcerowsecurity as force_rls
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname not like 'pg_%' and n.nspname<>'information_schema'
    and c.relkind in ('r','p','m','f') and not c.relispartition order by n.nspname,c.relname`)).rows;
  if (tables.some(t => t.kind === 'f')) throw fail('BACKUP_FOREIGN_TABLE_UNSUPPORTED');
  const columns = (await db.query(`select n.nspname as schema,c.relname as table_name,a.attname as name,
    pg_catalog.format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as not_null,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) as default_expr,a.attidentity as identity,a.attgenerated as generated
    from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where a.attnum>0 and not a.attisdropped and n.nspname not like 'pg_%' and n.nspname<>'information_schema'
    and c.relkind in ('r','p','m','v') order by n.nspname,c.relname,a.attnum`)).rows;
  const constraints = (await db.query(`select n.nspname as schema,c.relname as table_name,k.conname as name,k.convalidated as validated,
    k.contype as type,pg_catalog.pg_get_expr(k.conbin,k.conrelid) as expression,rn.nspname as referenced_schema,rc.relname as referenced_table,
    pg_catalog.pg_get_constraintdef(k.oid) as definition from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid=k.conrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    left join pg_catalog.pg_class rc on rc.oid=k.confrelid left join pg_catalog.pg_namespace rn on rn.oid=rc.relnamespace
    where n.nspname not like 'pg_%' and n.nspname<>'information_schema' order by n.nspname,c.relname,k.conname`)).rows;
  const indexes = (await db.query(`select schemaname,tablename,indexname,indexdef from pg_catalog.pg_indexes
    where schemaname not like 'pg_%' and schemaname<>'information_schema' order by schemaname,tablename,indexname`)).rows;
  const views = (await db.query(`select schemaname,viewname,definition from pg_catalog.pg_views
    where schemaname not like 'pg_%' and schemaname<>'information_schema' order by schemaname,viewname`)).rows;
  const routines = (await db.query(`select n.nspname as schema,p.proname as name,pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
    pg_catalog.pg_get_functiondef(p.oid) as definition from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname not like 'pg_%' and n.nspname<>'information_schema' and p.prokind in ('f','p') order by n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid)`)).rows;
  const triggers = (await db.query(`select n.nspname as schema,c.relname as table_name,t.tgname as name,t.tgenabled as enabled,
    pg_catalog.pg_get_triggerdef(t.oid) as definition from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname not like 'pg_%' and n.nspname<>'information_schema' order by n.nspname,c.relname,t.tgname`)).rows;
  const policies = (await db.query(`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_catalog.pg_policies
    where schemaname not like 'pg_%' and schemaname<>'information_schema' order by schemaname,tablename,policyname`)).rows;
  const enums = (await db.query(`select n.nspname as schema,t.typname as name,e.enumlabel as label,e.enumsortorder as position
    from pg_catalog.pg_enum e join pg_catalog.pg_type t on t.oid=e.enumtypid join pg_catalog.pg_namespace n on n.oid=t.typnamespace
    where n.nspname not like 'pg_%' and n.nspname<>'information_schema' order by n.nspname,t.typname,e.enumsortorder`)).rows;
  const sequences = (await db.query(`select n.nspname as schema,c.relname as name,pg_catalog.format_type(s.seqtypid,NULL) as type,
    s.seqstart::text as start,s.seqincrement::text as increment,s.seqmax::text as max,s.seqmin::text as min,s.seqcache::text as cache,s.seqcycle as cycle
    from pg_catalog.pg_sequence s join pg_catalog.pg_class c on c.oid=s.seqrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname not like 'pg_%' and n.nspname<>'information_schema' order by n.nspname,c.relname`)).rows;
  if (constraints.some(c => c.type === 'f' && Policy.excluded({ name: c.referenced_table }) && !Policy.excluded({ name: c.table_name }))) throw fail('BACKUP_EPHEMERAL_DEPENDENCY_REQUIRES_POLICY');
  return { tables, columns, constraints, indexes, views, routines, triggers, policies, enums, sequences };
}
async function tableState(db, meta) {
  const result = [];
  for (const t of meta.tables) {
    const cols = meta.columns.filter(c => c.schema === t.schema && c.table_name === t.name);
    const sessions = Policy.excluded(t);
    let count = 0; const digest = crypto.createHash('sha256');
    if (!sessions) {
      // Cursor bounds JS memory; sorting canonical rows also catches changed contents, not just counts.
      await db.query(`DECLARE pl41_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row_data FROM ${relation(t)} t ORDER BY (to_jsonb(t)::text) COLLATE "C"`);
      try {
        while (true) {
          const rows = (await db.query('FETCH FORWARD 250 FROM pl41_rows')).rows;
          if (!rows.length) break;
          for (const r of rows) { count++; digest.update(r.row_data + '\n'); }
        }
      } finally { await db.query('CLOSE pl41_rows'); }
    }
    const tenants = !sessions && cols.some(c => c.name === 'company_id') ? (await db.query(`select company_id::text as company_id,count(*)::text as count from ${relation(t)} group by company_id order by company_id nulls first`)).rows : [];
    result.push({ schema: t.schema, name: t.name, rows: count, sha256: digest.digest('hex'), tenants, ephemeralExcluded: sessions });
  }
  return result;
}
async function objectCatalog(db, meta) {
  const keys = new Map(), columns = [], skippedDeletedReferences = [];
  function add(key, ref) {
    if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024 || /[\0\r\n]/.test(key)) throw fail('BACKUP_STORAGE_KEY_INVALID');
    if (!keys.has(key)) keys.set(key, { key, references: [] });
    keys.get(key).references.push(ref);
  }
  for (const t of meta.tables) {
    const cols = meta.columns.filter(c => c.schema === t.schema && c.table_name === t.name);
    for (const col of cols.filter(c => storageColumn(c.name))) {
      const entry = { schema: t.schema, table: t.name, column: col.name, references: 0 };
      columns.push(entry);
      // This one confirmed tombstone is audit, not a live reference. Never omit pending cleanup.
      const tombstones = t.schema === 'public' && t.name === 'platform_company_purge_files' && col.name === 'storage_key' && cols.some(c => c.name === 'deleted_at');
      if (tombstones) {
        const count = Number((await db.query(`SELECT count(*)::text as count FROM ${relation(t)} WHERE storage_key IS NOT NULL AND deleted_at IS NOT NULL`)).rows[0].count);
        skippedDeletedReferences.push({ schema: t.schema, table: t.name, column: col.name, count,
          reason: 'deleted_at IS NOT NULL confirma eliminación intencional; fila de auditoría conservada íntegra en PostgreSQL.' });
      }
      // No tenant or job-status filter on live references.
      const optional = ['size','sha256'].filter(c => cols.some(x => x.name === c));
      const fields = [quote(col.name) + ' as key', ...optional.map(quote)].join(',');
      await db.query(`DECLARE pl41_keys NO SCROLL CURSOR FOR SELECT ${fields} FROM ${relation(t)} WHERE ${quote(col.name)} IS NOT NULL${tombstones ? ' AND deleted_at IS NULL' : ''}`);
      try {
        while (true) {
          const rows = (await db.query('FETCH FORWARD 250 FROM pl41_keys')).rows;
          if (!rows.length) break;
          for (const r of rows) { entry.references++; add(r.key, { ...entry, references: undefined, size: r.size == null ? null : Number(r.size), sha256: r.sha256 || null }); }
        }
      } finally { await db.query('CLOSE pl41_keys'); }
    }
    if (t.schema === 'public' && t.name === 'company_export_jobs') {
      const jobs = (await db.query("select id,company_id,status,storage_key,size,sha256 from public.company_export_jobs where status in ('ready','running') order by id")).rows;
      for (const job of jobs) {
        if (job.status === 'running') throw fail('BACKUP_PAUSE_EXPORT_WORKER_AND_RETRY');
        const key = `companies/${job.company_id}/exports/${job.id}.tar.gz`;
        if (job.storage_key && job.storage_key !== key) throw fail('BACKUP_DERIVED_KEY_MISMATCH');
        add(key, { schema: t.schema, table: t.name, column: 'derived:exportKey', size: job.size == null ? null : Number(job.size), sha256: job.sha256 || null });
      }
    }
  }
  const objects = [...keys.values()].sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return { columns, objects, referenceCount: columns.reduce((n,c) => n + c.references, 0), uniqueKeys: objects.length, skippedDeletedReferences };
}
async function inventory(db) {
  await db.query("SET LOCAL TIME ZONE 'UTC'");
  await db.query('SET LOCAL row_security = off'); // Fail instead of silently backing up only RLS-visible rows.
  const meta = await metadata(db);
  return { schema: meta, schemaHash: hash(meta), excludedEphemeral: Policy.exclusions(meta.tables), tables: await tableState(db, meta), catalog: await objectCatalog(db, meta) };
}
async function assertEmpty(db) {
  const objects = (await db.query(`select count(*)::int as count from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname not like 'pg_%' and n.nspname<>'information_schema'`)).rows[0];
  const routines = (await db.query(`select count(*)::int as count from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname not like 'pg_%' and n.nspname<>'information_schema'`)).rows[0];
  const schemas = (await db.query("select count(*)::int as count from pg_catalog.pg_namespace where nspname not like 'pg_%' and nspname not in ('public','information_schema')")).rows[0];
  if (objects.count || routines.count || schemas.count) throw fail('RESTORE_DATABASE_NOT_EMPTY');
}
async function validateLegacyChecks(db, meta) {
  let verified = 0;
  for (const c of meta.constraints.filter(c => !c.validated)) {
    if (c.type !== 'c' || !c.expression) throw fail('RESTORE_UNVALIDATED_CONSTRAINT_REQUIRES_REVIEW');
    // Preserve the original NOT VALID schema flag; independently check all restored rows.
    const r = (await db.query(`SELECT EXISTS(SELECT 1 FROM ${relation({schema:c.schema,name:c.table_name})} WHERE (${c.expression}) IS FALSE) AS invalid`)).rows[0];
    if (r.invalid) throw fail('RESTORE_LEGACY_CHECK_DATA_VIOLATION');
    verified++;
  }
  return verified;
}
module.exports = { quote, relation, hash, storageColumn, metadata, tableState, objectCatalog, inventory, assertEmpty, validateLegacyChecks };
