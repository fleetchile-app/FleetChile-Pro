/* Local recovery only: confirmation always comes from the authenticated API. */
(function(scope){
 'use strict';
 const MAX_BYTES=20*1024*1024,MAX_RECORDS=100;
 function owner(user){
  if(user?.role_code!=='driver'||![user.id,user.company_id,user.driver_id].every(v=>/^\d+$/.test(String(v))))throw Error('Identidad de conductor no validada');
  return [user.id,user.company_id,user.driver_id].join(':');
 }
 function indexedStore(indexedDB){
  let opened;
  const db=()=>opened||(opened=new Promise((resolve,reject)=>{
   const r=indexedDB.open('fleetchile-driver-private-v1',1);
   r.onupgradeneeded=()=>r.result.createObjectStore('records',{keyPath:'id'});
   r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('No se pudo abrir el almacenamiento local'));
   r.onblocked=()=>reject(Error('Cierra otras ventanas de FleetChile y reintenta'));
  }));
  async function run(mode,work){const database=await db();return new Promise((resolve,reject)=>{
   const tx=database.transaction('records',mode),store=tx.objectStore('records');let value;
   tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(Error('No se guardó el pendiente: revisa espacio y permisos del navegador'));
   work(store,v=>{value=v;});
  });}
  return {
   get:id=>run('readonly',(s,set)=>{const r=s.get(id);r.onsuccess=()=>set(r.result);}),
   all:()=>run('readonly',(s,set)=>{const r=s.getAll();r.onsuccess=()=>set(r.result);}),
   put:value=>run('readwrite',s=>s.put(value)),
   remove:id=>run('readwrite',s=>s.delete(id)),
   purge:prefix=>run('readwrite',s=>{const r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(c){if(c.key.startsWith(prefix))c.delete();c.continue();}};})
  };
 }
 function create(user,{store,crypto=scope.crypto,locks=scope.navigator?.locks}={}){
  const partition=owner(user),prefix=partition+'/',keyId=prefix+'@key';
  if(!crypto?.subtle||!store&&!scope.indexedDB)throw Error('Este navegador no permite guardar pendientes cifrados. No cierres el formulario sin conexión.');
  store=store||indexedStore(scope.indexedDB);let tail=Promise.resolve();
  const serial=work=>{const job=()=>locks?locks.request('fleet-vault-'+partition,work):work();const p=tail.then(job,job);tail=p.catch(()=>{});return p;};
  const rows=async()=>(await store.all()).filter(r=>r.id.startsWith(prefix)&&r.id!==keyId);
  async function key(){let record=await store.get(keyId);if(!record){record={id:keyId,key:await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt'])};await store.put(record);}return record.key;}
  async function decode(record){if(!record)return null;const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:record.iv,additionalData:new TextEncoder().encode(record.id)},await key(),record.data);return JSON.parse(new TextDecoder().decode(bytes));}
  return {
   partition,
   get:id=>serial(async()=>decode(await store.get(prefix+id))),
   list:()=>serial(async()=>Promise.all((await rows()).sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id)).map(decode))),
   put:(id,value)=>serial(async()=>{
    const rowId=prefix+id,previous=await store.get(rowId),all=await rows();
    const encoded=new TextEncoder().encode(JSON.stringify(value));
    if(all.length-(previous?1:0)>=MAX_RECORDS||all.reduce((n,r)=>n+r.bytes,0)-(previous?.bytes||0)+encoded.byteLength>MAX_BYTES)throw Error('Almacenamiento local lleno. Sincroniza o revisa pendientes; no se eliminó ninguno.');
    const iv=crypto.getRandomValues(new Uint8Array(12)),data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(rowId)},await key(),encoded);
    const created=previous?.created||Math.max(Date.now(),...all.map(r=>r.created+1));
    await store.put({id:rowId,iv,data,bytes:encoded.byteLength,created});return value;
   }),
   remove:id=>serial(()=>store.remove(prefix+id)),
   purge:()=>serial(()=>store.purge(prefix))
  };
 }
 const api={create,owner,MAX_BYTES,MAX_RECORDS,indexedStore};
 if(typeof module==='object'&&module.exports)module.exports=api;else scope.DriverVault=api;
})(typeof window==='object'?window:globalThis);
