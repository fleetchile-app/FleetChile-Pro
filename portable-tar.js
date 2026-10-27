'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),{createGzip}=require('node:zlib'),{pipeline}=require('node:stream/promises'),{Readable}=require('node:stream');
function header(name,size){
 if(!/^[A-Za-z0-9_./-]{1,99}$/.test(name)||name.includes('..')||name.startsWith('/')||!Number.isSafeInteger(size)||size<0||size>0o77777777777)throw Error('Entrada de paquete no válida');
 const b=Buffer.alloc(512),put=(v,at,len)=>b.write(v,at,len,'ascii'),oct=(v,n)=>v.toString(8).padStart(n-1,'0')+'\0';
 put(name,0,100);put('0000600\0',100,8);put(oct(0,8),108,8);put(oct(0,8),116,8);put(oct(size,12),124,12);put(oct(0,12),136,12);b.fill(32,148,156);b[156]=48;put('ustar\0',257,6);put('00',263,2);
 const sum=b.reduce((a,x)=>a+x,0);put(sum.toString(8).padStart(6,'0')+'\0 ',148,8);return b;
}
async function archive(entries,target,{maxBytes,signal}={}){
 let total=1024;for(const e of entries){const s=await fs.promises.stat(e.path);e.size=s.size;total+=512+Math.ceil(s.size/512)*512;}if(maxBytes&&total>maxBytes)throw Object.assign(Error('Exportación demasiado grande'),{exportCode:'EXPORT_SIZE_LIMIT'});
 async function* source(){for(const e of entries){yield header(e.name,e.size);for await(const chunk of fs.createReadStream(e.path))yield chunk;const pad=(512-e.size%512)%512;if(pad)yield Buffer.alloc(pad);}yield Buffer.alloc(1024);}
 await pipeline(Readable.from(source()),createGzip(),fs.createWriteStream(target,{mode:0o600,flags:'wx'}),{signal});
 const hash=crypto.createHash('sha256');for await(const c of fs.createReadStream(target))hash.update(c);return {size:(await fs.promises.stat(target)).size,sha256:hash.digest('hex')};
}
module.exports={archive,header};
