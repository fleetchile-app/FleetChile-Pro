'use strict';
const fail=(message,status=400,code='EQUIPMENT_INVALID')=>Object.assign(new Error(message),{status,code});
function id(v,label='Identificador',{optional=false,zero=false}={}){
 if(optional&&(v==null||v===''))return null;
 const n=typeof v==='number'||typeof v==='string'&&v.trim()?Number(v):NaN;
 if(!Number.isSafeInteger(n)||n<(zero?0:1))throw fail(`${label} no válido`);return n;
}
function text(v,label,max=2000){if(typeof v!=='string'||!v.trim()||v.length>max)throw fail(`${label} es obligatorio y admite hasta ${max} caracteres`);return v.trim();}
function instant(v,label){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v))throw fail(`${label} requiere fecha, hora y zona horaria`);
 const day=new Date(v.slice(0,10)+'T00:00:00Z'),d=new Date(v);
 if(Number.isNaN(d.getTime())||Number.isNaN(day.getTime())||day.toISOString().slice(0,10)!==v.slice(0,10))throw fail(`${label} no válida`);
 return d.toISOString();
}
function role(value){
 const s=String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[\s_-]/g,'');
 if(['tractocamion','tracto','tractor'].includes(s))return 'tractor';
 if(['remolque','semirremolque','trailer'].includes(s))return 'trailer';
 if(['camion','camionrigido','rigido'].includes(s))return 'truck';
 if(['equipo','equipment'].includes(s))return 'equipment';return null;
}
function pair(truck,trailer){
 if(!truck||!['truck','tractor','equipment'].includes(role(truck.tipo)))throw fail('Selecciona un camión, tractocamión o equipo principal; revisa su tipo en la ficha de vehículos');
 if(trailer){if(String(truck.id)===String(trailer.id))throw fail('El vehículo principal y el remolque deben ser distintos');
  if(role(trailer.tipo)!=='trailer')throw fail('El componente acoplado debe estar registrado como remolque o semirremolque');
  if(role(truck.tipo)==='equipment')throw fail('Para acoplar un remolque selecciona un camión o tractocamión');
 }
}
function capacity(truck,trailer){
 const v=trailer?trailer.capacidad_t:role(truck?.tipo)==='tractor'?null:truck?.capacidad_t;
 return v==null||!Number.isFinite(Number(v))||Number(v)<0?null:Number(v);
}
function windowCheck(snapshot,{status='Planificado',plannedDeparture,plannedArrival,now=new Date()}={}){
 if(!snapshot?.valid_from)return;
 const execution=['En carga','En tránsito'].includes(status),start=execution?new Date(now):new Date(plannedDeparture||now);
 const from=new Date(snapshot.valid_from),until=snapshot.valid_until?new Date(snapshot.valid_until):null;
 const end=plannedArrival?new Date(plannedArrival):null;
 if(Number.isNaN(start.getTime())||Number.isNaN(from.getTime())||(until&&Number.isNaN(until.getTime()))||(end&&Number.isNaN(end.getTime())))throw fail('Fechas del conjunto o del viaje no válidas');
 if(start<from||until&&(start>=until||!end||end>until||end<=start))throw fail('La vigencia del conjunto no cubre el viaje. Revisa fechas o selecciona otro conjunto.',409,'COMPOSITION_OUTSIDE_WINDOW');
}
module.exports={fail,id,text,instant,role,pair,capacity,windowCheck};
