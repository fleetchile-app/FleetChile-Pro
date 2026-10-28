'use strict';
const E=require('./equipment-domain');
const CATEGORIES=['truck','tractor','trailer','equipment'];
const MODULES=['operations','maintenance','gps','fuel','reports','pod','economics'];
const fail=(message,status=400,code='COMMERCIAL_INVALID')=>Object.assign(Error(message),{status,code});
function integer(v,label,min=0){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>1000000000)throw fail(label+' no válido');return v;}
function modules(values){if(!Array.isArray(values)||new Set(values).size!==values.length||values.some(v=>!MODULES.includes(v)))throw fail('Selecciona módulos válidos y sin duplicados');return [...values].sort();}
function quantities(value){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!CATEGORIES.includes(k)))throw fail('Capacidades por categoría no válidas');return Object.fromEntries(CATEGORIES.map(k=>[k,integer(value[k]??0,'Cantidad '+k)]));}
function plan(b){const allowed=modules(b.allowed_modules),included=modules(b.included_modules);if(included.some(m=>!allowed.includes(m)))throw fail('Los módulos incluidos deben estar permitidos por el plan');return {code:E.text(b.code,'Código',40),name:E.text(b.name,'Nombre',100),max_equipment:integer(b.max_equipment,'Máximo del plan',1),allowed_modules:allowed,included_modules:included};}
function quote(b,p,current,now=new Date()){
 if(!['initial','renewal','expansion'].includes(b.kind))throw fail('Tipo de propuesta no válido');
 const q=quantities(b.quantities),total=Object.values(q).reduce((n,v)=>n+v,0);
 if(!total||total>p.max_equipment)throw fail('Los cupos contratados deben estar entre 1 y el máximo del plan');
 const prices=Object.fromEntries(CATEGORIES.map(k=>[k,q[k]?integer(b.unit_prices?.[k], 'Precio acordado '+k):null]));
 const selected=modules(b.modules),enabled=[...new Set([...selected,...p.included_modules])].sort();
 if(enabled.some(m=>!p.allowed_modules.includes(m)))throw fail('El plan no permite uno de los módulos seleccionados');
 const extras=Object.fromEntries(enabled.map(m=>[m,p.included_modules.includes(m)?0:integer(b.module_prices?.[m],'Precio acordado '+m)]));
 const period_from=E.instant(b.period_from,'Inicio del período'),period_until=E.instant(b.period_until,'Fin del período'),valid_until=E.instant(b.valid_until,'Validez de la propuesta');
 const from=Date.parse(period_from),until=Date.parse(period_until),at=now.getTime();
 if(until<=from||until<=at||Date.parse(valid_until)<=at||Date.parse(valid_until)>until)throw fail('Período o validez de propuesta no válidos');
 const full=CATEGORIES.reduce((n,k)=>n+q[k]*prices[k],0)+Object.values(extras).reduce((n,v)=>n+v,0);
 if(!Number.isSafeInteger(full)||full>Number.MAX_SAFE_INTEGER/2)throw fail('Importe fuera de rango');
 let amount=full,proration=null;
 if(b.kind==='initial'&&current)throw fail('Ya existe un período pagado: usa renovación o ampliación',409);
 if(b.kind==='renewal'&&current){const end=new Date(current.period_until).getTime();if(end>at&&from!==end)throw fail('La renovación debe comenzar al finalizar el último período pagado');if(end<=at&&from<at-900000)throw fail('Tras un vencimiento, inicia el nuevo período al renovar, sin cobrar días anteriores sin servicio');}
 if(b.kind==='expansion'){
  if(!current||new Date(current.period_until).getTime()<=at)throw fail('La ampliación requiere un período pagado vigente o futuro');
  const old=current.configuration;
  if(from!==new Date(current.period_from).getTime()||until!==new Date(current.period_until).getTime())throw fail('La ampliación conserva el período y su fecha común de renovación');
  if(CATEGORIES.some(k=>q[k]<old.quantities[k]||old.quantities[k]>0&&prices[k]!==old.unit_prices[k])||old.modules.some(m=>!enabled.includes(m)||extras[m]!==old.module_prices[m]))throw fail('La ampliación no reduce cupos, retira módulos ni modifica precios anteriores');
  const delta=full-old.period_price_clp;if(delta<0)throw fail('La ampliación no puede generar un cargo negativo');
  const fraction=(until-Math.max(at,from))/(until-from);amount=Math.round(delta*fraction);
  if(delta>0&&amount===0)throw fail('El remanente es menor a un peso: tramita la capacidad en la próxima renovación');
  proration={calculated_at:now.toISOString(),remaining_seconds:(until-Math.max(at,from))/1000,period_seconds:(until-from)/1000,delta_period_clp:delta,rounding:'CLP entero, sobre el total'};
 }
 return {kind:b.kind,period_from,period_until,valid_until,amount_clp:amount,configuration:{plan_id:p.id,plan_code:p.code,plan_name:p.name,max_equipment:p.max_equipment,quantities:q,unit_prices:prices,modules:enabled,module_prices:extras,period_price_clp:full,proration},reason:E.text(b.reason,'Motivo',2000)};
}
function state(contract,now=new Date()){if(!contract)return 'unconfigured';if(now<new Date(contract.period_from))return 'scheduled';if(now>=new Date(contract.period_until))return 'expired';return 'active';}
function moduleFor(path){
 path=path.toLowerCase().replace(/\/+$/,'');
 if(/\/api\/location-picker(?:\/|$)/.test(path))return 'operations';
 if(/\/api\/(?:fleet\/)?trucks\/\d+\/(?:positions?|track|history|location)$/.test(path)||/\/api\/fleet\/positions$/.test(path)||/\/api\/driver\/trips\/\d+\/positions$/.test(path))return 'gps';
 if(/(?:\/maintenance|\/work-orders|\/maintenance-routines)/.test(path))return 'maintenance';
 if(/\/fuel(?:\/|$)/.test(path))return 'fuel';
 if(/\/deliveries(?:\/|$)/.test(path)||/\/delivery-proofs(?:\/|$)/.test(path))return 'pod';
 if(/\/economics\//.test(path))return /\/reports(?:\/|$)/.test(path)?'reports':'economics';
 if(/\/(?:trips|routes|loads)(?:\/|$)/.test(path))return 'operations';
 return null;
}
module.exports={CATEGORIES,MODULES,fail,integer,modules,quantities,plan,quote,state,moduleFor};
