'use strict';
const fail=message=>{throw Object.assign(Error(message),{status:400});};
function parse(body){
 const number=(v,label,zero=false)=>{if(!['number','string'].includes(typeof v)||String(v).trim()===''||!Number.isFinite(Number(v))||(zero?Number(v)<0:Number(v)<=0))fail(label+' no válido');return Number(v);};
 const liters=number(body.liters,'Litros'),odometer=number(body.odometer_km,'Odómetro',true),total=number(body.total_clp,'Total CLP');
 if(!Number.isSafeInteger(total))fail('Total CLP debe ser entero');
 if(typeof body.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(body.date)||Number.isNaN(Date.parse(body.date))||new Date(body.date).toISOString().slice(0,10)!==body.date||body.date>new Date().toISOString().slice(0,10))fail('Fecha real de abastecimiento no válida');
 if(!['cash','card','debit','credit','agreement','internal'].includes(body.payment_method))fail('Selecciona el medio de pago');
 const station=body.station??'',reference=body.receipt_reference??'';
 if(typeof station!=='string'||station.length>200||typeof reference!=='string'||reference.length>160||/[\x00-\x1f]/.test(station+reference))fail('Proveedor o referencia no válido');
 return {liters,odometer,total,date:body.date,payment:body.payment_method,station:station.trim()||null,reference:reference.trim()||null};
}
async function insert(db,cid,truck,b){return (await db.query(`insert into fuel(company_id,date,truck,truck_id,liters,price_clp,total_clp,station,odometer_km,supply_type,payment_method,receipt_reference) values($1,$2,$3,$4,$5,$6::numeric/$5::numeric,$6,$7,$8,$11,$9,$10) returning *`,[cid,b.date,truck.patente,truck.id,b.liters,b.total,b.station,b.odometer,b.payment,b.reference,b.payment==='internal'?'internal':'external'])).rows[0];}
module.exports={parse,insert};
