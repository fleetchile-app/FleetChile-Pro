'use strict';
const E=require('./enterprise-common');
const specs={
 clients:{permission:'clients.manage',columns:['name','rut','client_code','identity_type','email','phone','commune_id','assigned_person_rut'],required:['name','rut']},
 vehicles:{permission:'fleet.manage',columns:['patente','brand','model','tipo','capacity_t','vin','engine_number','circulation_expiry','soap_expiry','inspection_expiry'],required:['patente','brand','model','tipo']},
 people:{permission:'company.people.manage',columns:['name','rut','birth_date','job_title'],required:['name','rut']}
};
const columnLabels={name:'nombre',client_code:'codigo_cliente',identity_type:'tipo_identidad',email:'correo',phone:'telefono',commune_id:'comuna_id',assigned_person_rut:'responsable_rut',brand:'marca',model:'modelo',capacity_t:'capacidad_t',engine_number:'numero_motor',circulation_expiry:'permiso_circulacion_hasta',soap_expiry:'soap_hasta',inspection_expiry:'revision_tecnica_hasta',birth_date:'fecha_nacimiento',job_title:'cargo'};
function parseCsv(csv,kind){
 const spec=typeof kind==='string'&&Object.hasOwn(specs,kind)?specs[kind]:null;if(!spec)E.fail(400,'Selecciona clientes, vehículos o personas');
 if(typeof csv!=='string'||Buffer.byteLength(csv,'utf8')>1048576||csv.includes('\0')||csv.includes('\ufffd'))E.fail(400,'CSV UTF-8 no válido o superior a 1 MiB');
 csv=csv.replace(/^\ufeff/,'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
 const first=csv.split('\n')[0],delimiter=(first.match(/;/g)||[]).length>(first.match(/,/g)||[]).length?';':',';
 let quoted=false,closed=false,cell='',row=[],rows=[],line=1,start=1;
 const push=()=>{row.push(cell);cell='';closed=false;};
 const end=()=>{push();if(row.some(c=>c.trim()))rows.push({line:start,cells:row});row=[];start=line+1;};
 for(let i=0;i<csv.length;i++){
  const c=csv[i];
  if(quoted){if(c==='"'){if(csv[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else{cell+=c;if(c==='\n')line++;}}
  else if(c===delimiter)push();else if(c==='\n'){end();line++;}else if(c==='"'){if(cell.trim()||closed)E.fail(400,`Comillas no válidas en línea ${line}`);cell='';quoted=true;}else if(closed){if(!/\s/.test(c))E.fail(400,`Contenido después de comillas en línea ${line}`);}else cell+=c;
  if(rows.length>201||row.length>30||cell.length>2000)E.fail(400,'Máximo 200 filas, 30 columnas y 2000 caracteres por celda');
 }
 if(quoted)E.fail(400,'Falta cerrar una celda entre comillas');if(cell||row.length)end();
 const aliases=Object.fromEntries(Object.entries(columnLabels).map(([k,v])=>[v,k]));
 const headers=rows.shift()?.cells.map(h=>{const key=h.trim();return Object.hasOwn(aliases,key)?aliases[key]:key});
 if(!headers?.length||new Set(headers).size!==headers.length||headers.some(h=>!spec.columns.includes(h))||spec.required.some(h=>!headers.includes(h)))E.fail(400,'Encabezados no válidos: descarga la plantilla de este tipo');
 if(!rows.length||rows.length>200)E.fail(400,'El archivo debe contener de 1 a 200 filas de datos');
 return rows.map(r=>({line:r.line,data:Object.fromEntries(headers.map((h,i)=>[h,(r.cells[i]||'').trim()])),parse_error:r.cells.length!==headers.length?'Cantidad de columnas distinta de la cabecera':null}));
}
async function validateRows(db,cid,kind,rows){
 const seen=new Set(),result=[];
 for(const row of rows){
  try{
   if(row.parse_error)E.fail(400,row.parse_error);const raw={...row.data};let data,key;
   if(kind==='clients'){
    const {validateClient}=require('./client-domain'),{validateRelations}=require('./client-api');
    const assigned=raw.assigned_person_rut;delete raw.assigned_person_rut;
    for(const k of Object.keys(raw))if(raw[k]==='')delete raw[k];
    if(assigned){const rut=require('./personnel-domain').normalizeRut(assigned);const person=(await db.query('select id from company_people where company_id=$1 and rut=$2',[cid,rut])).rows[0];if(!person)E.fail(400,'Responsable no encontrado en esta empresa');raw.assigned_person_id=person.id;}
    data=validateClient(raw);await validateRelations(db,cid,data,null);key=data.normalized_rut;
    if(data.client_code){const codeKey='code:'+data.client_code.toLowerCase();if(seen.has(codeKey)||(await db.query('select id from clients where company_id=$1 and lower(client_code)=lower($2)',[cid,data.client_code])).rows.length)E.fail(400,'Código de cliente duplicado');seen.add(codeKey);}
   }else if(kind==='vehicles'){
    const {bodyOf}=require('./vehicle-profile-api');for(const k of Object.keys(raw))if(raw[k]==='')delete raw[k];
    if(raw.capacity_t!==undefined){if(!/^\d+(\.\d+)?$/.test(raw.capacity_t))E.fail(400,'Capacidad: número no negativo con punto decimal');raw.capacity_t=Number(raw.capacity_t);}
    raw.patente=raw.patente?.toUpperCase();data=bodyOf({body:raw});key=data.patente.replace(/[^A-Z0-9]/g,'');
    if(!key||(await db.query("select 1 from trucks where upper(regexp_replace(patente,'[^A-Za-z0-9]','','g'))=$1",[key])).rows.length)E.fail(400,'Patente no disponible o duplicada');
   }else{
    const {validatePerson,companyDate}=require('./personnel-domain'),pol=(await db.query('select time_zone from company_personnel_policies where company_id=$1',[cid])).rows[0];
    const v=validatePerson(raw,{draft:true,today:companyDate(new Date(),pol?.time_zone)});if(v.error)E.fail(400,v.error);data=v.value;if(!data.rut)E.fail(400,'El RUT es obligatorio en la importación');key=data.rut;
    if((await db.query('select id from company_people where company_id=$1 and rut=$2',[cid,data.rut])).rows.length)E.fail(400,'RUT ya registrado en esta empresa');
   }
   if(seen.has(key))E.fail(400,'Identificador duplicado dentro del archivo');seen.add(key);
   result.push({line:row.line,valid:true,data});
  }catch(e){if(!e.status)throw e;result.push({line:row.line,valid:false,error:e.message});}
 }
 return result;
}
module.exports={specs,columnLabels,parseCsv,validateRows};
