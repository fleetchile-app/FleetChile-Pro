'use strict';
const fail=(message,status=400,code='MAINTENANCE_INVALID')=>Object.assign(new Error(message),{status,code});
function text(value,label,{required=false,max=4000}={}){
 if(value===null||value===undefined||value===''){if(required)throw fail(`${label} es obligatorio`);return null;}
 if(typeof value!=='string'||value.length>max||!value.trim())throw fail(`${label} no válido`);
 return value.trim();
}
function number(value,label,{required=false,integer=false,positive=false}={}){
 if(value===null||value===undefined||value===''){if(required)throw fail(`${label} es obligatorio`);return null;}
 if(!['string','number'].includes(typeof value)||!String(value).trim())throw fail(`${label} no válido`);
 const n=Number(value);
 if(!Number.isFinite(n)||n<0||(positive&&n===0)||(integer&&!Number.isSafeInteger(n))||n>1e12)throw fail(`${label} no válido`);
 return n;
}
const id=(value,label='Identificador',required=true)=>number(value,label,{required,integer:true,positive:true});
function instant(value,label,now=new Date()){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))throw fail(`${label} no válido`);
 date(value.slice(0,10),label);
 const d=new Date(value);
 if(Number.isNaN(d.getTime())||d.getTime()>now.getTime()+300000)throw fail(`${label} no puede ser inválido ni futuro`);
 return d.toISOString();
}
function date(value,label='Fecha programada'){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw fail(`${label} no válida`);
 const d=new Date(value+'T00:00:00Z');if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==value)throw fail(`${label} no válida`);
 return value;
}
function routine(value){
 if(value===null||value===undefined)return null;
 if(typeof value!=='object'||Array.isArray(value))throw fail('Rutina no válida');
 const r={name:text(value.name,'Nombre de rutina',{required:true,max:160}),days:number(value.days,'Intervalo días',{integer:true,positive:true}),km:number(value.km,'Intervalo km',{integer:true,positive:true}),hours:number(value.hours,'Intervalo horas',{positive:true})};
 if(!r.days&&!r.km&&!r.hours)throw fail('La rutina requiere intervalo de días, km u horas');
 if(r.days>36500)throw fail('Intervalo de días no válido');return r;
}
function item(b){
 if(!['part','labor','service'].includes(b.kind))throw fail('Tipo de trabajo/repuesto no válido');
 if(!['pending','done','cancelled'].includes(b.status||'pending'))throw fail('Estado de trabajo no válido');
 return {kind:b.kind,description:text(b.description,'Descripción',{required:true,max:1000}),quantity:number(b.quantity,'Cantidad',{required:true,positive:true}),estimated_unit_cost_clp:number(b.estimated_unit_cost_clp,'Precio estimado',{integer:true}),actual_unit_cost_clp:number(b.actual_unit_cost_clp,'Precio real',{integer:true}),status:b.status||'pending',note:text(b.note,'Nota')};
}
function costs(lines){
 const active=lines.filter(l=>l.status!=='cancelled');
 const sum=key=>active.some(l=>l[key]===null||l[key]===undefined)?null:active.reduce((n,l)=>n+Math.round(Number(l.quantity)*Number(l[key])),0);
 return {estimated:active.length?sum('estimated_unit_cost_clp'):null,actual:active.length?sum('actual_unit_cost_clp'):null,unknown_actual:active.filter(l=>l.actual_unit_cost_clp===null||l.actual_unit_cost_clp===undefined).length};
}
function version(order,value){
 if(id(value,'Versión')!==Number(order.work_order_version))throw fail('La orden cambió. Actualiza la ficha antes de guardar.',409,'MAINTENANCE_CONFLICT');
}
module.exports={fail,text,number,id,instant,date,routine,item,costs,version};
