'use strict';
// All SQL identifiers below come from pg_catalog, never from HTTP input.
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const fail=message=>Object.assign(Error(message),{status:409});
const indirect=new Set(['client_locations','driver_documents','personnel_notification_reads','telemetry','trip_loads','vehicle_checklists','vehicle_documents','delivery_proof_files','trip_delivery_proofs','trip_status_history','trip_events']);
async function catalog(db){
 const tables=(await db.query(`select c.oid::int oid,c.relname name,array_agg(a.attname order by a.attnum) cols,
 (select array_agg(x.attname order by k.ord) from pg_index i cross join lateral unnest(i.indkey) with ordinality k(num,ord) join pg_attribute x on x.attrelid=c.oid and x.attnum=k.num where i.indrelid=c.oid and i.indisprimary) pk
 from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where n.nspname='public' and c.relkind='r' group by c.oid,c.relname order by c.relname`)).rows;
 const fks=(await db.query(`select c.oid::int oid,c.conrelid::int child,c.confrelid::int parent,
 array_agg(a.attname order by k.ord) cols,array_agg(b.attname order by k.ord) refs,
 array_agg(a.attname order by k.ord) filter(where not a.attnotnull and a.attname<>'company_id') nullable_cols,
 bool_or(not a.attnotnull and a.attname<>'company_id') nullable
 from pg_constraint c cross join lateral unnest(c.conkey,c.confkey) with ordinality k(a,b,ord)
 join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.a join pg_attribute b on b.attrelid=c.confrelid and b.attnum=k.b
 where c.contype='f' group by c.oid,c.conrelid,c.confrelid order by c.oid`)).rows;
 return {tables,fks};
}
const rowKey=(t,a)=>'jsonb_build_array('+t.pk.map(c=>a+'.'+quote(c)).join(',')+')';
const selected=(t,a)=>`exists(select 1 from purge_rows r where r.rel=${t.oid} and r.key=${rowKey(t,a)})`;
async function plan(db,cid,{lock=false}={}){
 const {tables,fks}=await catalog(db),map=new Map(tables.map(t=>[t.oid,t]));
 if(lock){await db.query('LOCK TABLE '+tables.map(t=>'public.'+quote(t.name)).join(',')+' IN SHARE ROW EXCLUSIVE MODE');if(JSON.stringify(await catalog(db))!==JSON.stringify({tables,fks}))throw fail('El esquema cambió. Revisa y prepara nuevamente la eliminación');}
 await db.query('CREATE TEMP TABLE purge_rows(rel oid,key jsonb,primary key(rel,key)) ON COMMIT DROP');
 for(const t of tables){if(t.name==='users'||t.name.startsWith('platform_company_purge_'))continue;
  if(t.name!=='companies'&&!t.cols.includes('company_id'))continue;
  if(!t.pk?.length)throw fail('Tabla empresarial sin clave primaria: '+t.name);
  await db.query(`insert into purge_rows select ${t.oid},${rowKey(t,'t')} from public.${quote(t.name)} t where t.${t.name==='companies'?'id':'company_id'}=$1 on conflict do nothing`,[cid]);
 }
 let added=1;
 while(added){added=0;for(const f of fks){const child=map.get(f.child),parent=map.get(f.parent);
  if(!child&&parent&&(await db.query('select 1 from purge_rows where rel=$1 limit 1',[parent.oid])).rows.length)throw fail('Dependencia fuera del esquema autorizado; eliminación bloqueada');
  if(!child||!parent||child.name==='users'||!parent.pk?.length)continue;
  const join=f.cols.map((c,i)=>`c.${quote(c)}=p.${quote(f.refs[i])}`).join(' and '),from=`from public.${quote(child.name)} c join public.${quote(parent.name)} p on ${join} where ${selected(parent,'p')}`;
  if(!(await db.query(`select 1 ${from} limit 1`)).rows.length)continue;
  if(child.name.startsWith('platform_company_purge_')||(!child.cols.includes('company_id')&&!indirect.has(child.name)))throw fail('Dependencia global no autorizada: '+child.name);
  if(!child.pk?.length)throw fail('Dependencia sin clave primaria: '+child.name);
  if(child.cols.includes('company_id')&&(await db.query(`select 1 ${from} and c.company_id is distinct from $1 limit 1`,[cid])).rows.length)throw fail('Hay referencias desde otra empresa; no se eliminará ningún dato');
  const r=await db.query(`insert into purge_rows select ${child.oid},${rowKey(child,'c')} ${from} on conflict do nothing`);added+=r.rowCount;
 }}
 for(const f of fks){const c=map.get(f.child),p=map.get(f.parent);if(!c?.pk?.length||c.name==='users'||!p?.cols.includes('company_id')||p.name==='users')continue;
  if((await db.query(`select 1 from public.${quote(c.name)} c join public.${quote(p.name)} p on ${f.cols.map((x,i)=>'c.'+quote(x)+'=p.'+quote(f.refs[i])).join(' and ')} where ${selected(c,'c')} and p.company_id is distinct from $1 limit 1`,[cid])).rows.length)throw fail('Un registro está relacionado con otra empresa; eliminación bloqueada');
 }
 const counts=(await db.query('select rel::int oid,count(*)::int count from purge_rows group by rel')).rows.map(r=>({table:map.get(r.oid).name,count:r.count}));
 return {tables,fks,map,counts};
}
async function erase(db,cid,p){
 const triggers=(await db.query(`select c.relname name,t.tgname,t.tgenabled from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal and t.tgenabled<>'D'`)).rows;
 const touched=new Set(p.counts.map(t=>t.table));touched.add('users');touched.add('user_sessions');
 // Transactional DDL: conflicting writes are blocked until every trigger is restored.
 for(const t of triggers.filter(t=>touched.has(t.name)))await db.query(`alter table public.${quote(t.name)} disable trigger ${quote(t.tgname)}`);
 const identities=(await db.query(`select u.id,(u.company_id is not null and u.company_id<>$1) or exists(select 1 from platform_memberships p where p.user_id=u.id) or exists(select 1 from platform_owners o where o.user_id=u.id) or exists(select 1 from user_memberships m where m.user_id=u.id and m.company_id<>$1) or exists(select 1 from roles r where r.id=u.role_id and (r.code='admin' or r.code like 'platform_%')) protected
 from users u where u.company_id=$1 or exists(select 1 from user_memberships m where m.user_id=u.id and m.company_id=$1)`,[cid])).rows;
 for(const u of identities){
  if(!u.protected){await db.query('delete from user_sessions where user_id=$1',[u.id]);await db.query("update users set active=false,password_hash=null,must_change_password=true,name='Cuenta eliminada',email=$2,phone=null,company_id=null,driver_id=null where id=$1",[u.id,'deleted-'+u.id+'-'+require('node:crypto').randomUUID()+'@invalid.local']);}
  else await db.query('update users set company_id=null,driver_id=null where id=$1 and company_id=$2',[u.id,cid]);
 }
 for(const f of p.fks){const c=p.map.get(f.child),parent=p.map.get(f.parent);if(!c?.pk?.length||!parent?.pk?.length||!f.nullable||c.name==='users')continue;
  await db.query('SAVEPOINT purge_pointer');
  try{await db.query(`update public.${quote(c.name)} c set ${f.nullable_cols.map(x=>quote(x)+'=null').join(',')} where ${selected(c,'c')} and exists(select 1 from public.${quote(parent.name)} p where ${selected(parent,'p')} and ${f.cols.map((x,i)=>'c.'+quote(x)+'=p.'+quote(f.refs[i])).join(' and ')})`);await db.query('RELEASE SAVEPOINT purge_pointer');}
  catch(e){await db.query('ROLLBACK TO SAVEPOINT purge_pointer');await db.query('RELEASE SAVEPOINT purge_pointer');if(!['23514','23502','23503','23001'].includes(e.code))throw e;}
 }
 let remaining=p.counts.map(x=>p.tables.find(t=>t.name===x.table)).sort((a,b)=>Number(a.name==='companies')-Number(b.name==='companies'));
 while(remaining.length){const failed=[];let progress=false;for(const t of remaining){await db.query('SAVEPOINT purge_table');try{await db.query(`delete from public.${quote(t.name)} t where ${selected(t,'t')}`);await db.query('RELEASE SAVEPOINT purge_table');progress=true;}catch(e){await db.query('ROLLBACK TO SAVEPOINT purge_table');await db.query('RELEASE SAVEPOINT purge_table');if(!['23503','23001','23514','23502'].includes(e.code))throw e;failed.push(t);}}if(!progress)throw fail('Dependencias pendientes. Se revirtió íntegramente la eliminación');remaining=failed;}
 for(const t of triggers.filter(t=>touched.has(t.name)))await db.query(`alter table public.${quote(t.name)} ${t.tgenabled==='A'?'enable always':t.tgenabled==='R'?'enable replica':'enable'} trigger ${quote(t.tgname)}`);
 return {identities_anonymized:identities.filter(u=>!u.protected).length,identities_preserved:identities.filter(u=>u.protected).length};
}
module.exports={catalog,plan,erase};
