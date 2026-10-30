'use strict';
const fail=message=>{throw Object.assign(Error(message),{status:400});};
function provision(body){
 if(body.valuation_pending!==undefined&&typeof body.valuation_pending!=='boolean')fail('Valoración pendiente no válida');
 const pending=body.valuation_pending===true,empty=body.price_clp===null||body.price_clp===undefined||body.price_clp==='';
 if(pending&&!empty)fail('Una valoración pendiente no debe incluir precio');
 const price=empty?null:Number(body.price_clp);
 if(!pending&&(!['number','string'].includes(typeof body.price_clp)||!Number.isFinite(price)||price<=0))fail('price_clp debe ser mayor que cero');
 const supply=body.supply_type??'unspecified',payment=body.payment_method??'unspecified',reference=body.receipt_reference??'';
 if(!['unspecified','internal','external'].includes(supply)||!['unspecified','cash','card','agreement','internal'].includes(payment))fail('Tipo de abastecimiento o medio de pago no válido');
 if(typeof reference!=='string'||reference.length>160||/[\x00-\x1f]/.test(reference))fail('Referencia no válida');
 return {price,supply,payment,reference:reference.trim()||null};
}
module.exports={provision};
