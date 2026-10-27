'use strict';
const crypto=require('node:crypto');
const {fail,id,text}=require('./equipment-domain');
function money(v,label='Monto'){if(v==null||typeof v==='boolean'||typeof v==='object'||String(v).trim()===''||!Number.isSafeInteger(Number(v))||Number(v)<0)throw fail(label+' debe ser un entero CLP no negativo',400,'FINANCE_INVALID');return Number(v);}
function sum(values){const total=values.reduce((n,v)=>n+money(v),0);if(!Number.isSafeInteger(total))throw fail('El total excede el rango seguro',400,'FINANCE_INVALID');return total;}
const recognized=v=>v.item_status!=='voided'&&v.cost_group==='direct'&&['approved','reconciled'].includes(v.status)&&['observed','allocated'].includes(v.cost_basis);
const pending=v=>v.item_status!=='voided'&&v.cost_group==='direct'&&['draft','pending_approval','approved'].includes(v.status);
function summarize(trip,profile,costs){
 const actual=costs.filter(recognized),approved=actual.filter(v=>v.status==='approved'),reconciled=actual.filter(v=>v.status==='reconciled');
 const revenue=profile?.revenue_defined===true&&trip.revenue_clp!=null?money(trip.revenue_clp):null,real=actual.length?sum(actual.map(v=>v.amount_clp)):null;
 return {revenue_clp:revenue,recognized_costs_clp:real,approved_clp:approved.length?sum(approved.map(v=>v.amount_clp)):null,reconciled_clp:reconciled.length?sum(reconciled.map(v=>v.amount_clp)):null,
  planned_clp:costs.some(v=>v.item_status!=='voided'&&v.cost_basis==='planned')?sum(costs.filter(v=>v.item_status!=='voided'&&v.cost_basis==='planned').map(v=>v.amount_clp)):null,
  pending_items:costs.filter(pending).length,delta_clp:revenue==null||real==null?null:revenue-real,
  delta_status:revenue==null||real==null?'missing_data':costs.some(pending)?'provisional':'reconciled'};
}
function budget(entries){
 if(!Array.isArray(entries)||!entries.length||entries.length>30)throw fail('Indica entre 1 y 30 partidas de presupuesto');const seen=new Set();
 return entries.map(e=>{const category=text(e.category_code,'Categoría',50);if(seen.has(category))throw fail('No repitas categorías del presupuesto');seen.add(category);if(e.includes_vat!==true&&e.includes_vat!==false&&e.includes_vat!==null)throw fail('Indica la condición de IVA de cada partida');return {category_code:category,amount_clp:money(e.amount_clp),includes_vat:e.includes_vat};});
}
function distribution(entries,loads,summary){
 if(summary.revenue_clp==null||summary.recognized_costs_clp==null)throw fail('Confirma ingresos y costos reconocidos antes de distribuir',409,'FINANCE_INCOMPLETE');
 if(!Array.isArray(entries)||entries.length!==loads.length||!loads.length)throw fail('Distribuye explícitamente entre todas las cargas del viaje');const seen=new Set();
 const rows=entries.map(e=>{const loadId=id(e.load_id,'Carga'),load=loads.find(l=>String(l.id)===String(loadId));if(!load||seen.has(loadId))throw fail('Carga ajena, inexistente o repetida',403);seen.add(loadId);return {load_id:loadId,client_id:Number(load.client_id),cargo:load.cargo,revenue_clp:money(e.revenue_clp),cost_clp:money(e.cost_clp)};});
 if(sum(rows.map(r=>r.revenue_clp))!==summary.revenue_clp||sum(rows.map(r=>r.cost_clp))!==summary.recognized_costs_clp)throw fail('Los repartos deben sumar exactamente el ingreso y costo reconocidos del viaje');
 return rows.map(r=>({...r,delta_clp:r.revenue_clp-r.cost_clp}));
}
function basis(trip,profile,costs,loads){return {revenue:profile?.revenue_defined?trip.revenue_clp:null,vat:profile?.revenue_includes_vat??null,costs:costs.filter(recognized).map(c=>[String(c.id),String(c.version_id),String(c.amount_clp),c.amount_includes_vat]).sort((a,b)=>a[0].localeCompare(b[0])),loads:loads.map(l=>[String(l.id),String(l.client_id)]).sort((a,b)=>a[0].localeCompare(b[0]))};}
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function csvCell(v){let raw=v??'';if(typeof raw==='string'&&/^[\t\r\n ]*[=+@-]/.test(raw))raw="'"+raw;return '"'+String(raw).replace(/"/g,'""')+'"';}
module.exports={money,sum,recognized,pending,summarize,budget,distribution,basis,hash,csvCell};
