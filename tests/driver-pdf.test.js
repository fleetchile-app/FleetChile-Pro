'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {generateDriverPdf,wrapLine}=require('../driver-pdf');
test('genera PDF binario multipágina legible sin dependencia externa',()=>{
 const pdf=generateDriverPdf({driver:{name:'Ana Ñeira',username:'ana',rut:'12.345.678-5'},trips:Array.from({length:70},(_,i)=>({trip_number:`V-${i}`,status:'Completado',origin:'A',destination:'B'}))});
 assert.equal(Buffer.isBuffer(pdf),true);assert.match(pdf.toString('latin1',0,80),/^%PDF-1\.4/);assert.match(pdf.toString('latin1'),/\/Count [2-9]/);assert.match(pdf.toString('latin1'),/Ana Neira/);
});
test('envuelve notas largas y conserva todo el historial con encabezado y paginación',()=>{
 const note='inicio '+('X'.repeat(6000))+' termino';
 const pdf=generateDriverPdf({driver:{name:'Conductor'},events:[{event_type:'note',event_date:'2026-01-01',notes:note}]});
 const text=pdf.toString('latin1');
 assert.ok(wrapLine(note).every(line=>line.length<=55));
 assert.match(text,/FleetChile - Ficha operacional de conductor/);
 assert.match(text,/Fecha de generacion \\\(UTC\\\): \d{4}-\d{2}-\d{2}/);
 assert.match(text,/Pagina 1 de/);
 assert.match(text,/inicio/);assert.match(text,/termino/);
 assert.ok((text.match(/Pagina \d+ de \d+/g)||[]).length>1);
});
test('normaliza guiones tipograficos de faltantes y no duplica titulo en cuerpo',()=>{
 const text=generateDriverPdf({driver:{name:'—'},events:[{event_type:'note',event_date:'2026-01-01',ends_on:'2026-01-02',notes:'–'}]}).toString('latin1');
 assert.doesNotMatch(text,/[—–]/);assert.doesNotMatch(text,/\?\)/);assert.equal((text.match(/FleetChile - Ficha operacional de conductor/g)||[]).length,1);
});
test('formatea fechas Date de PostgreSQL como ISO civil y no como texto local',()=>{
 const pdf=generateDriverPdf({licenses:[{classes:'A4',issued_date:new Date('2026-01-02T00:00:00Z'),printed_expiry:new Date('2027-01-02T00:00:00Z'),effective_expiry:new Date('2027-01-02T00:00:00Z')}],events:[{event_date:new Date('2026-02-03T00:00:00Z'),ends_on:new Date('2026-02-10T00:00:00Z'),event_type:'note',notes:'ok'}]});
 const text=pdf.toString('latin1');assert.match(text,/2026-01-02/);assert.match(text,/2026-02-03/);assert.doesNotMatch(text,/Sun Jan|Mon Jan|GMT|T00:00:00/);
});
