'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {attachment}=require('../financial-support-api'),{provision}=require('../fuel-registration');
test('precio pendiente es explícito y no acepta ceros ficticios, booleanos ni enums arbitrarios',()=>{
 assert.equal(provision({valuation_pending:true,price_clp:null}).price,null);
 for(const b of [{valuation_pending:'true'},{valuation_pending:true,price_clp:1},{price_clp:false},{price_clp:0},{price_clp:100,supply_type:'xx'},{price_clp:100,receipt_reference:'x'.repeat(161)}])assert.throws(()=>provision(b));
});
test('respaldo admite archivos limitados y rechaza codificación, tipo y acciones obvias en PDF',async()=>{
 for(const data of ['https://invalid.example/file.pdf','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,YmFk','data:application/pdf;base64,'+Buffer.from('%PDF-1.4 /JavaScript %%EOF').toString('base64'),'x'.repeat(7000001)])await assert.rejects(attachment(data),e=>e.status===400);
 assert.equal(await attachment(null),null);
 const pdf=Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');assert.equal((await attachment('data:application/pdf;base64,'+pdf.toString('base64'))).mime,'application/pdf');
});
