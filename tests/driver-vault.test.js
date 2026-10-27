'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const V=require('../public/driver-vault');
const user={id:1,company_id:2,driver_id:3,role_code:'driver'};
function memory(){const rows=new Map();return {rows,async get(id){return rows.get(id);},async all(){return [...rows.values()];},async put(v){rows.set(v.id,structuredClone(v));},async remove(id){rows.delete(id);},async purge(prefix){for(const id of rows.keys())if(id.startsWith(prefix))rows.delete(id);}};}
test('vault cifra evidencia y RUT sin token, recupera tras recarga y usa clave no exportable',async()=>{
 const store=memory(),a=V.create(user,{store,crypto:webcrypto});
 const value={id:'pod-1',state:'queued',recipient_rut:'12345678-5',signature:'data:image/png;base64,fixture'};
 await a.put(value.id,value);const raw=store.rows.get('1:2:3/pod-1');assert.equal(raw.data instanceof ArrayBuffer,true);
 assert.equal(JSON.stringify(raw).includes(value.recipient_rut),false);assert.equal(store.rows.get('1:2:3/@key').key.extractable,false);
 const b=V.create(user,{store,crypto:webcrypto});assert.deepEqual(await b.get('pod-1'),value);assert.equal((await b.list()).length,1);
 await b.remove('pod-1');assert.deepEqual(await a.list(),[]);
});
test('vault aísla usuarios, empresas y conductores; logout no elimina otras particiones',async()=>{
 const store=memory(),a=V.create(user,{store,crypto:webcrypto}),b=V.create({...user,company_id:4},{store,crypto:webcrypto});
 await a.put('draft',{id:'draft',state:'draft',notes:'empresa A'});await b.put('draft',{id:'draft',notes:'empresa B'});
 assert.equal((await a.get('draft')).notes,'empresa A');await a.purge();assert.equal(await a.get('draft'),null);assert.equal((await b.get('draft')).notes,'empresa B');
 assert.throws(()=>V.create({...user,role_code:'company_admin'},{store,crypto:webcrypto}),/Identidad/);
});
test('vault detecta alteración de cifrado y limita capacidad sin borrar pendientes',async()=>{
 const store=memory(),a=V.create(user,{store,crypto:webcrypto});await a.put('first',{id:'first',notes:'conservar'});
 await assert.rejects(a.put('huge',{text:'x'.repeat(V.MAX_BYTES+1)}),/lleno/);assert.equal((await a.get('first')).notes,'conservar');
 const row=store.rows.get('1:2:3/first');new Uint8Array(row.data)[0]^=1;await assert.rejects(a.get('first'));
});
test('vault comunica error de almacenamiento, sin fallback de datos personales en texto plano',async()=>{
 const store=memory();store.put=async()=>{throw Error('quota')};const a=V.create(user,{store,crypto:webcrypto});await assert.rejects(a.put('x',{private:true}),/quota/);assert.equal(store.rows.size,0);
 assert.throws(()=>V.create(user,{store:memory(),crypto:{}}),/cifrados/);
});
