const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('vencimiento de licencia se presenta como DD-MM-YYYY sin alterar la fecha',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
 const definition=source.match(/function formatDateOnly\(v\)\{[^\n]+\}/)?.[0];
 assert.ok(definition,'No se encontró formatDateOnly');
 const formatDateOnly=Function(`${definition};return formatDateOnly`)();
 assert.equal(formatDateOnly('2027-09-21T00:00:00.000Z'),'21-09-2027');
 assert.equal(formatDateOnly('2026-12-08'),'08-12-2026');
 assert.equal(formatDateOnly(null),'—');
 assert.equal(formatDateOnly(''),'—');
 assert.match(source,/const driver=x=>\[[^\n]*formatDateOnly\(x\.expiry\)/);
});
