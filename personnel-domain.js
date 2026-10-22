'use strict';

const LICENSE_CLASSES=Object.freeze(['A1','A2','A3','A4','A5','B','C','CR','D','E','F','A1_OLD','A2_OLD']);
const CONTRACT_TYPES=Object.freeze(['indefinite','fixed','day','event']);
const CONDITION_TYPES=Object.freeze(['permission','medical_leave','vacation','suspended']);
const normalizeRut=value=>{
 if(typeof value!=='string')return '';
 const raw=value.replace(/[.\s-]/g,'').toUpperCase();
 if(!/^\d{1,8}[0-9K]$/.test(raw))return '';
 const body=raw.slice(0,-1).replace(/^0+/,'');
 return body?body+'-'+raw.slice(-1):'';
};
function validateRut(value){
 const normalized=normalizeRut(value);if(!normalized)return false;
 const [body,dv]=normalized.split('-');let sum=0,multiplier=2;
 for(let i=body.length-1;i>=0;i--){sum+=Number(body[i])*multiplier;multiplier=multiplier===7?2:multiplier+1}
 const remainder=11-sum%11,expected=remainder===11?'0':remainder===10?'K':String(remainder);
 return expected===dv;
}
function formatRut(value){
 const normalized=normalizeRut(value);if(!normalized)return String(value??'');
 const [body,dv]=normalized.split('-');return body.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+'-'+dv;
}
function validDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const time=new Date(value+'T00:00:00.000Z');
 return Number.isFinite(time.getTime())&&time.toISOString().slice(0,10)===value;
}
function companyDate(now=new Date(),timeZone='America/Santiago'){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const get=type=>parts.find(part=>part.type===type).value;
 return get('year')+'-'+get('month')+'-'+get('day');
}
const text=(value,max)=>typeof value==='string'&&value.trim().length<=max?value.trim():null;
function validatePerson(input={},options={}){
 if(!input||typeof input!=='object'||Array.isArray(input))return {error:'Datos personales no válidos'};
 const value={},partial=options.partial===true,draft=options.draft===true;
 if(!partial||Object.hasOwn(input,'name')){value.name=text(input.name,160);if(!value.name)return {error:'El nombre es obligatorio (máximo 160 caracteres)'}}
 if(!partial||Object.hasOwn(input,'rut')){
  value.rut=input.rut?normalizeRut(input.rut):null;
  if(input.rut?!validateRut(value.rut):!draft)return {error:'RUT incorrecto: revisa el número y su dígito verificador'};
 }
 if(!partial||Object.hasOwn(input,'birth_date')){
  value.birth_date=input.birth_date||null;
  if(value.birth_date?(!validDate(value.birth_date)||value.birth_date>(options.today||companyDate())):!draft)return {error:'La fecha de nacimiento es obligatoria, válida y no puede ser futura'};
 }
 if(!partial||Object.hasOwn(input,'job_title')){value.job_title=text(input.job_title??'',160);if(value.job_title===null)return {error:'Cargo no válido (máximo 160 caracteres)'}}
 return {value};
}
function validateContract(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))return {error:'Contrato no válido'};
 const type=input.type,start=input.start_date,end=input.end_date||null;
 if(!CONTRACT_TYPES.includes(type)||!validDate(start))return {error:'Selecciona tipo de contrato y fecha de inicio válidos'};
 if(type==='indefinite'&&end!==null)return {error:'El contrato indefinido no tiene fecha de término'};
 if(type!=='indefinite'&&(!validDate(end)||end<start))return {error:'La fecha de término es obligatoria y no puede ser anterior al inicio'};
 if(type==='day'&&end!==start)return {error:'El contrato por día comienza y termina en la misma fecha'};
 const event_name=text(input.event_name??'',200);
 if(event_name===null||type==='event'&&!event_name)return {error:'El contrato por evento requiere un nombre de evento (máximo 200 caracteres)'};
 return {value:{type,start_date:start,end_date:end,event_name:type==='event'?event_name:null}};
}
function validateCondition(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))return {error:'Condición no válida'};
 if(!CONDITION_TYPES.includes(input.type)||!validDate(input.start_date)||!validDate(input.end_date)||input.end_date<input.start_date)return {error:'Selecciona una condición e indica inicio y término válidos'};
 return {value:{type:input.type,start_date:input.start_date,end_date:input.end_date}};
}
function licenseEffectiveExpiry(printed){
 if(!validDate(printed))return null;
 if(printed.startsWith('2025-'))return '2026-12-31';
 if(!printed.startsWith('2026-'))return printed;
 const [year,month,day]=printed.split('-').map(Number),target=new Date(Date.UTC(year,month-1+6,1));
 const lastDay=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
 target.setUTCDate(Math.min(day,lastDay));return target.toISOString().slice(0,10);
}
function validateLicense(input={},options={}){
 if(!input||typeof input!=='object'||Array.isArray(input))return {error:'Licencia no válida'};
 if(!Array.isArray(input.classes)||!input.classes.length||input.classes.some(code=>!LICENSE_CLASSES.includes(code)))return {error:'Selecciona al menos una clase de licencia del catálogo'};
 const printed_expiry=input.printed_expiry,issued_date=input.issued_date||null;
 if(!validDate(printed_expiry)||issued_date&&(!validDate(issued_date)||issued_date>printed_expiry))return {error:'Revisa las fechas de emisión y vencimiento de la licencia'};
 if(issued_date&&issued_date>(options.today||companyDate()))return {error:'La fecha de emisión de la licencia no puede ser futura'};
 return {value:{classes:[...new Set(input.classes)],issued_date,printed_expiry,effective_expiry:licenseEffectiveExpiry(printed_expiry)}};
}
function evaluateEligibility({person,contracts=[],conditions=[],licenses=[],role_code,account_active=true,membership_active=true,today=companyDate()}={}){
 const reasons=[];
 if(!account_active)reasons.push('ACCOUNT_DISABLED');
 if(!membership_active)reasons.push('MEMBERSHIP_DISABLED');
 if(!person)return {allowed:false,code:'PERSONNEL_ACCESS_BLOCKED',reasons:[...reasons,'PERSON_NOT_REGULARIZED']};
 if(person.user_id===null)reasons.push('ACCOUNT_MISSING');
 const exempt=role_code==='company_admin'&&person.contract_exempt===true&&Boolean(person.exemption_by)&&Boolean(person.exemption_at);
 if(!exempt&&(!validateRut(person.rut)||!validDate(person.birth_date)||person.birth_date>today))reasons.push('PERSON_NOT_REGULARIZED');
 const records=contracts.filter(row=>!row.voided_at);
 if(!exempt&&!records.some(row=>validDate(row.start_date)&&row.start_date<=today&&(!row.end_date||validDate(row.end_date)&&row.end_date>=today))){
  reasons.push(!records.length?'CONTRACT_MISSING':records.every(row=>row.start_date>today)?'CONTRACT_NOT_STARTED':'CONTRACT_EXPIRED');
 }
 if(conditions.some(row=>!row.cancelled_at&&validDate(row.start_date)&&validDate(row.end_date)&&row.start_date<=today&&row.end_date>=today))reasons.push('CONDITION_ACTIVE');
 if(role_code==='driver'){
  if(!person.driver_id)reasons.push('DRIVER_NOT_ASSOCIATED');
  const license=licenses.find(row=>row.current!==false);
  if(!license||!Array.isArray(license.classes)||!license.classes.length||license.classes.some(code=>!LICENSE_CLASSES.includes(code))||!validDate(license.effective_expiry)||license.issued_date&&(!validDate(license.issued_date)||license.issued_date>today))reasons.push('DRIVER_LICENSE_MISSING');
  else if(license.effective_expiry<today)reasons.push('DRIVER_LICENSE_EXPIRED');
 }
 return {allowed:reasons.length===0,code:reasons.length?'PERSONNEL_ACCESS_BLOCKED':null,reasons};
}
module.exports={LICENSE_CLASSES,CONTRACT_TYPES,CONDITION_TYPES,normalizeRut,formatRut,validateRut,validDate,companyDate,validatePerson,validateContract,validateCondition,validateLicense,licenseEffectiveExpiry,evaluateEligibility};
