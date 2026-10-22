'use strict';
const crypto=require('node:crypto');
const {normalizeRut,validateRut,validDate,companyDate}=require('./personnel-domain');
const fail=(status,message)=>Object.assign(new Error(message),{status});
const identifier=value=>{if(!['string','number'].includes(typeof value)||typeof value==='number'&&!Number.isSafeInteger(value))throw fail(400,'Identificador no válido');const text=String(value);if(!/^[1-9]\d*$/.test(text)||BigInt(text)>9223372036854775807n)throw fail(400,'Identificador no válido');return text;};
const enums={identity_type:['person','company'],preferred_contact:['call','whatsapp','email'],segment:['retail','wholesale'],relationship:['prospect','customer','recurring']};
const lengths={name:200,client_code:40,contact_name:160,email:254,phone:40,mobile:40,street:200,street_number:30,city:100,postal_code:20,address:500,commune:100,region:100,website:500,social_url:500,branch_name:120};
function text(value,max){if(value===null||value===undefined||value==='')return null;if(typeof value!=='string'||value.trim().length>max||/[\u0000-\u001f\u007f]/.test(value))throw fail(400,'Texto inválido o demasiado largo');return value.trim()||null;}
function reason(value){const out=text(value,1000);if(!out)throw fail(400,'Indica el motivo del cambio');return out;}
function validateClient(input,{partial=false}={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail(400,'Ficha de cliente no válida');
 const out={};
 for(const k of ['company_id','normalized_rut','created_at','updated_at','privacy_status'])if(Object.hasOwn(input,k))throw fail(400,`El campo ${k} no se modifica desde este formulario`);
 for(const [k,max] of Object.entries(lengths))if(Object.hasOwn(input,k))out[k]=text(input[k],max);
 if((!partial||Object.hasOwn(input,'name'))&&!out.name)throw fail(400,'Nombre o razón social obligatorio');
 if(!partial||Object.hasOwn(input,'rut')){if(!validateRut(input.rut))throw fail(400,'RUT incorrecto: revisa el dígito verificador');out.rut=normalizeRut(input.rut);out.normalized_rut=out.rut;}
 if(out.client_code&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(out.client_code))throw fail(400,'Código de cliente: usa letras, números, punto, guion o guion bajo');
 for(const [k,allowed] of Object.entries(enums))if(Object.hasOwn(input,k)){if(input[k]!==null&&input[k]!==''&&!allowed.includes(input[k]))throw fail(400,`Selecciona una opción válida para ${k}`);out[k]=input[k]||null;}
 if(out.identity_type===null||out.relationship===null)throw fail(400,'Selecciona tipo de identidad y relación comercial');
 if(!partial){out.identity_type??='company';out.relationship??='customer';}
 if(out.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email))throw fail(400,'Correo electrónico no válido');
 for(const k of ['website','social_url'])if(out[k]){let url;try{url=new URL(out[k]);}catch{throw fail(400,'Los enlaces deben incluir https:// o http://');}if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw fail(400,'Enlace web no permitido');out[k]=url.href;}
 for(const k of ['commune_id','assigned_person_id'])if(Object.hasOwn(input,k))out[k]=input[k]===null||input[k]===''?null:identifier(input[k]);
 if(Object.hasOwn(input,'active')){if(typeof input.active!=='boolean')throw fail(400,'Estado de cliente inválido');out.active=input.active;}
 return out;
}
function validateDocument(input,today=companyDate()){
 if(!['template','signed'].includes(input?.kind))throw fail(400,'Selecciona documento para firma o respaldo firmado');
 const why=reason(input.reason),filename=text(input.filename,160);
 if(!filename||!filename.toLowerCase().endsWith('.pdf')||/[\\/]/.test(filename))throw fail(400,'Selecciona un archivo PDF');
 if(typeof input.content!=='string'||input.content.length>1398104||input.content.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.content))throw fail(400,'PDF inválido o superior a 1 MiB');
 const buffer=Buffer.from(input.content,'base64');
 if(!buffer.length||buffer.length>1048576||buffer.toString('base64')!==input.content||buffer.subarray(0,5).toString()!=='%PDF-'||!buffer.subarray(-2048).includes(Buffer.from('%%EOF')))throw fail(400,'El archivo no parece un PDF válido (máximo 1 MiB)');
 const signer_name=text(input.signer_name,160),signer_capacity=text(input.signer_capacity,160),signed_on=input.signed_on||null;
 if(input.kind==='signed'&&(!signer_name||!validDate(signed_on)||signed_on>today))throw fail(400,'Indica firmante y fecha de firma válida, no futura');
 return {kind:input.kind,reason:why,filename,buffer,sha256:crypto.createHash('sha256').update(buffer).digest('hex'),signer_name:input.kind==='signed'?signer_name:null,signer_capacity:input.kind==='signed'?signer_capacity:null,signed_on:input.kind==='signed'?signed_on:null};
}
module.exports={fail,identifier,text,reason,validateClient,validateDocument};
