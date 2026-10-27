'use strict';
const crypto=require('node:crypto');
const sharp=require('sharp');
const PALETTES={ocean:'#1265a8',forest:'#23634c',slate:'#394d65'};
const fail=message=>{throw Object.assign(new Error(message),{status:400})};
function text(value,key,max){
 if(typeof value!=='string'||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail(`${key}: valor no válido`);
 return value.trim();
}
function validateSettings(body){
 const allowed=['expected_version','display_name','palette','contact_name','contact_email','contact_phone','logo','reason','reset'];
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))fail('Configuración no válida');
 if(!Number.isSafeInteger(body.expected_version)||body.expected_version<0)fail('Versión no válida');
 const reason=text(body.reason,'Motivo',500);if(reason.length<5)fail('Indica un motivo de al menos cinco caracteres');
 if(body.reset!==undefined&&typeof body.reset!=='boolean')fail('Restablecimiento no válido');
 if(body.reset===true)return {display_name:'',palette:'ocean',contact_name:'',contact_email:'',contact_phone:'',logo:null,reason};
 const result={display_name:text(body.display_name,'Nombre comercial',120),palette:body.palette,
  contact_name:text(body.contact_name,'Contacto',120),contact_email:text(body.contact_email,'Correo',254),contact_phone:text(body.contact_phone,'Teléfono',40),reason};
 if(!Object.hasOwn(PALETTES,result.palette))fail('Selecciona una combinación de colores disponible');
 if(result.contact_email&&!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result.contact_email))fail('Correo operativo no válido');
 if(body.logo!==undefined)result.logo=body.logo;
 return result;
}
async function normalizeLogo(value){
 if(value===null)return {logo:null,logo_width:null,logo_height:null};
 if(typeof value!=='string'||value.length>1400000||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))fail('Selecciona una imagen PNG, JPEG o WebP de máximo 1 MiB');
 const encoded=value.split(',')[1],buffer=Buffer.from(encoded,'base64');
 if(buffer.length>1048576||buffer.toString('base64')!==encoded)fail('Imagen demasiado grande o codificación inválida');
 try{
  const image=sharp(buffer,{limitInputPixels:16000000,failOn:'warning'}),meta=await image.metadata();
  if(!['png','jpeg','webp'].includes(meta.format)||(meta.pages||1)>1||!meta.width||!meta.height)fail('Formato de imagen no permitido');
  const {data,info}=await image.rotate().resize({width:600,height:240,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:88}).toBuffer({resolveWithObject:true});
  if(data.length>300000)fail('El logo procesado supera el tamaño permitido');
  return {logo:data,logo_width:info.width,logo_height:info.height};
 }catch(error){if(error.status)throw error;fail('El archivo no es una imagen válida o supera las dimensiones permitidas')}
}
async function loadBranding(db,companyId){
 const company=(await db.query('select id,legal_name,rut,trade_name from companies where id=$1',[companyId])).rows[0];
 if(!company)throw Object.assign(new Error('Empresa no encontrada'),{status:404});
 const revision=(await db.query('select * from company_branding_revisions where company_id=$1 order by version desc limit 1',[companyId])).rows[0];
 return {company_id:company.id,legal_name:company.legal_name,rut:company.rut,version:revision?.version||0,
  display_name:revision?.display_name||company.trade_name||company.legal_name,palette:revision?.palette||'ocean',
  contact_name:revision?.contact_name||'',contact_email:revision?.contact_email||'',contact_phone:revision?.contact_phone||'',
  logo:revision?.logo?Buffer.from(revision.logo):null,logo_width:revision?.logo_width||null,logo_height:revision?.logo_height||null,
  updated_at:revision?.created_at||null,updated_by:revision?.created_by||null};
}
function identitySnapshot(b){return {company_id:b.company_id,legal_name:b.legal_name,rut:b.rut,display_name:b.display_name,palette:b.palette,version:b.version,
 contact_name:b.contact_name,contact_email:b.contact_email,contact_phone:b.contact_phone,logo_sha256:b.logo?crypto.createHash('sha256').update(b.logo).digest('hex'):null}}
function publicBranding(b){return {...identitySnapshot(b),logo_url:b.logo?'data:image/jpeg;base64,'+b.logo.toString('base64'):null,updated_at:b.updated_at,updated_by:b.updated_by};}
module.exports={PALETTES,validateSettings,normalizeLogo,loadBranding,identitySnapshot,publicBranding};
