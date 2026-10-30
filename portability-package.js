'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Readable,Transform}=require('node:stream'),{pipeline}=require('node:stream/promises');
const C=require('./portability-catalog'),{archive}=require('./portable-tar');
const code=(name)=>Object.assign(new Error(name),{exportCode:name});
function limits(env=process.env){
 const bytes=Number(env.EXPORT_MAX_BYTES||104857600),rows=Number(env.EXPORT_MAX_ROWS||1000000),files=Number(env.EXPORT_MAX_FILES||10000),timeout=Number(env.EXPORT_TIMEOUT_MS||600000);
 if(!Number.isSafeInteger(bytes)||bytes<1048576||bytes>1073741824||!Number.isSafeInteger(rows)||rows<1||rows>10000000||!Number.isSafeInteger(files)||files<1||files>50000||!Number.isSafeInteger(timeout)||timeout<1000||timeout>1800000)throw Error('Límites de exportación no válidos');
 return {maxBytes:bytes,maxRows:rows,maxFiles:files,timeoutMs:timeout};
}
const stream=body=>Buffer.isBuffer(body)||body instanceof Uint8Array?Readable.from([body]):body&&typeof body[Symbol.asyncIterator]==='function'?body:body?.getReader?Readable.fromWeb(body):(()=>{throw code('EXPORT_ATTACHMENT_UNAVAILABLE')})();
async function digest(file){const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex')}
async function packageCompany(db,job,store,{env=process.env,signal,tempRoot=os.tmpdir()}={}){
 const cfg=limits(env),root=await fs.promises.realpath(tempRoot),dir=await fs.promises.mkdtemp(path.join(root,'fleetchile-export-'));
 const entries=[],datasets=[],attachments=[];let used=0,rowCount=0;
 const budget=n=>{used+=n;if(used>cfg.maxBytes)throw code('EXPORT_SIZE_LIMIT');if(signal?.aborted)throw code('EXPORT_TIMEOUT')};
 const add=async(name,file,extra={})=>{const size=(await fs.promises.stat(file)).size,sha256=await digest(file);entries.push({name,path:file});return {file:name,size,sha256,...extra}};
 try{
  await fs.promises.writeFile(path.join(dir,'export-job.json'),JSON.stringify({job_id:job.id,company_id:job.company_id}),{mode:0o600});
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL TIME ZONE 'UTC'");
  await db.query("select set_config('statement_timeout',$1,true)",[String(Math.min(cfg.timeoutMs,60000))]);
  const snapshot=(await db.query('select transaction_timestamp()::text snapshot_at')).rows[0].snapshot_at;
  const cat=await C.catalog(db);
  for(const e of cat){
   const json=path.join(dir,e.name+'.json'),handle=await fs.promises.open(json,'wx',0o600),csv=e.csv?await fs.promises.open(path.join(dir,e.name+'.csv'),'wx',0o600):null;
   let count=0,header=false;
   const write=async(h,s)=>{budget(Buffer.byteLength(s));await h.writeFile(s)};
   try{
    await write(handle,'[\n');await db.query('DECLARE export_rows NO SCROLL CURSOR FOR '+e.sql,[job.company_id]);
    while(true){const batch=(await db.query('FETCH FORWARD 200 FROM export_rows')).rows;if(!batch.length)break;
     for(const raw of batch){if(++rowCount>cfg.maxRows)throw code('EXPORT_ROW_LIMIT');const row=C.scrub(raw,job.company_id);await write(handle,(count?',\n':'')+JSON.stringify(row));count++;
      if(csv){if(!header){await write(csv,'\ufeff'+Object.keys(row).map(C.csvCell).join(';')+'\r\n');header=true;}await write(csv,Object.values(row).map(C.csvCell).join(';')+'\r\n');}
     }
    }
    await db.query('CLOSE export_rows');await write(handle,'\n]\n');if(csv&&!header)await write(csv,'\ufeff'+(e.columns||[]).map(C.csvCell).join(';')+'\r\n');
   }finally{await handle.close();await csv?.close()}
   const data=await add('data/'+e.name+'.json',json,{rows:count});if(csv)data.csv=await add('csv/'+e.name+'.csv',path.join(dir,e.name+'.csv'));datasets.push(data);
  }
  const sources=[];
  const push=s=>{sources.push(s);if(sources.length>cfg.maxFiles)throw code('EXPORT_FILE_LIMIT')};
  const pod=(await db.query(`select f.id,f.storage_key,f.size,f.sha256,f.mime_type from delivery_proof_files f join trip_delivery_proofs d on d.id=f.proof_id join trips t on t.id=d.trip_id where t.company_id=$1 limit $2`,[job.company_id,cfg.maxFiles+1])).rows;
  for(const r of pod)push({...r,file:`files/pod/${r.id}.bin`,kind:'s3'});
  const consents=(await db.query('select id,storage_key,size,sha256,mime_type from client_consent_documents where company_id=$1 limit $2',[job.company_id,cfg.maxFiles+1])).rows;
  for(const r of consents)push({...r,file:`files/consents/${r.id}.pdf`,kind:'s3'});
  const financial=(await db.query('select id,storage_key,size,sha256,mime_type from financial_support_entries where company_id=$1 and storage_key is not null limit $2',[job.company_id,cfg.maxFiles+1])).rows;
  for(const r of financial)push({...r,file:`files/financial-support/${r.id}.bin`,kind:'s3'});
  const issued=(await db.query('select id,octet_length(pdf) size,sha256 from company_issued_documents where company_id=$1 limit $2',[job.company_id,cfg.maxFiles+1])).rows;
  for(const r of issued)push({...r,file:`files/issued/${r.id}.pdf`,kind:'issued',mime_type:'application/pdf'});
  const logos=(await db.query('select version,octet_length(logo) size from company_branding_revisions where company_id=$1 and logo is not null limit $2',[job.company_id,cfg.maxFiles+1])).rows;
  for(const r of logos)push({...r,id:r.version,file:`files/branding/${r.version}.jpg`,kind:'logo',mime_type:'image/jpeg'});
  for(let i=0;i<sources.length;i++){
   const s=sources[i],file=path.join(dir,'attachment-'+i),size=Number(s.size);if(!Number.isSafeInteger(size)||size<0||used+size>cfg.maxBytes)throw code('EXPORT_SIZE_LIMIT');
   let body;
   if(s.kind==='s3'){
    if(!s.storage_key?.startsWith(`companies/${job.company_id}/`)||s.storage_key.includes('..'))throw code('EXPORT_ATTACHMENT_SCOPE');
    try{body=(await store.get(s.storage_key,{signal})).Body}catch{throw code('EXPORT_ATTACHMENT_UNAVAILABLE')}
   }else{
    const table=s.kind==='issued'?'company_issued_documents':'company_branding_revisions',column=s.kind==='issued'?'pdf':'logo',key=s.kind==='issued'?'id':'version';
    body=(await db.query(`select ${column} body from ${table} where company_id=$1 and ${key}=$2`,[job.company_id,s.id])).rows[0]?.body;if(!body)throw code('EXPORT_ATTACHMENT_UNAVAILABLE');
   }
   let written=0;const hash=crypto.createHash('sha256'),check=new Transform({transform(chunk,encoding,cb){try{written+=chunk.length;budget(chunk.length);if(written>size)throw code('EXPORT_ATTACHMENT_INTEGRITY');hash.update(chunk);cb(null,chunk)}catch(e){cb(e)}}});
   await pipeline(stream(body),check,fs.createWriteStream(file,{flags:'wx',mode:0o600}),{signal});
   const actual=hash.digest('hex');if(written!==size||s.sha256&&s.sha256.toLowerCase()!==actual)throw code('EXPORT_ATTACHMENT_INTEGRITY');
   entries.push({name:s.file,path:file});attachments.push({file:s.file,size,sha256:actual,mime_type:s.mime_type});
  }
  await db.query('COMMIT');
  const manifest={format:'fleetchile-company-export-v1',company_id:job.company_id,job_id:job.id,snapshot_at:snapshot,created_at:new Date().toISOString(),datasets,attachments,
   exclusions:['Contraseñas, sesiones y credenciales','Propietarios, memberships globales y datos de otras empresas','Cuerpos de auditoría genérica y borradores de importación','Objetos externos enlazados: sus referencias se conservan sin descargar URLs'],
   purpose:'Portabilidad legible de una empresa. No es un respaldo restaurable ni incluye un importador de restauración.'};
  const manifestFile=path.join(dir,'manifest.json'),readme=path.join(dir,'LEEME.txt');const text=JSON.stringify(manifest,null,2)+'\n';budget(Buffer.byteLength(text));await fs.promises.writeFile(manifestFile,text,{mode:0o600});entries.push({name:'manifest.json',path:manifestFile});
  const help='FleetChile - Exportación de empresa\n\nAbra manifest.json para consultar alcance, fecha y verificaciones SHA-256.\nLos datos están en data/ (JSON UTF-8) y csv/ (CSV seguro para planillas).\nLos archivos privados administrados están en files/. Los .bin de POD conservan su MIME en el manifiesto.\nNo se descargan enlaces externos ni se incluyen credenciales o sesiones.\nEsta exportación NO permite restaurar el sistema. PL41 es un proceso diferente.\nProteja este paquete: contiene datos personales y comerciales.\n';budget(Buffer.byteLength(help));await fs.promises.writeFile(readme,help,{mode:0o600});entries.push({name:'LEEME.txt',path:readme});
  const target=path.join(dir,'company.tar.gz'),result=await archive(entries,target,{maxBytes:cfg.maxBytes,signal});
  return {target,manifest,...result,cleanup:async()=>{if(path.dirname(dir)===root&&path.basename(dir).startsWith('fleetchile-export-'))await fs.promises.rm(dir,{recursive:true,force:true})}};
 }catch(e){try{await db.query('ROLLBACK')}catch{}if(path.dirname(dir)===root&&path.basename(dir).startsWith('fleetchile-export-'))await fs.promises.rm(dir,{recursive:true,force:true});throw e;}
}
async function cleanupTemps(db,{tempRoot=os.tmpdir()}={}){
 const root=await fs.promises.realpath(tempRoot);
 for(const entry of await fs.promises.readdir(root,{withFileTypes:true})){
  if(!entry.isDirectory()||!entry.name.startsWith('fleetchile-export-'))continue;
  const dir=await fs.promises.realpath(path.join(root,entry.name));if(path.dirname(dir)!==root)continue;
  let marker;try{marker=JSON.parse(await fs.promises.readFile(path.join(dir,'export-job.json'),'utf8'))}catch{continue;}
  if(!/^[0-9a-f-]{36}$/i.test(marker.job_id||''))continue;
  const row=(await db.query("select id from company_export_jobs where id=$1 and company_id=$2 and status<>'running'",[marker.job_id,marker.company_id])).rows[0];
  if(row)await fs.promises.rm(dir,{recursive:true,force:true});
 }
}
module.exports={packageCompany,limits,stream,cleanupTemps};
