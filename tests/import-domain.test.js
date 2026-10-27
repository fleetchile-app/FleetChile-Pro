'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseCsv}=require('../import-domain');
test('CSV admite BOM, coma/punto y coma, comillas escapadas y números de línea',()=>{
 const r=parseCsv('\ufeffname;rut;job_title\r\n"Ana; Pérez";12345678-5;"Jefa ""turno"""\r\n','people');
 assert.equal(r.length,1);assert.equal(r[0].line,2);assert.equal(r[0].data.name,'Ana; Pérez');assert.equal(r[0].data.job_title,'Jefa "turno"');
 assert.equal(parseCsv('name,rut\nAna,12345678-5','people')[0].data.name,'Ana');
 assert.equal(parseCsv('nombre;rut;cargo\nAna;12345678-5;Bodega','people')[0].data.job_title,'Bodega');
});
test('CSV rechaza cabeceras ambiguas, tamaño/filas excesivos, comillas rotas y tipos no permitidos',()=>{
 for(const [csv,kind] of [['name;name\nA;B','people'],['name;company_id\nA;20','people'],['name;rut\n"A;B','people'],['name;rut\n"A"X;B','people'],['name;rut\nA;B','__proto__'],['name;rut\n'+('A;B\n'.repeat(201)),'people'],['name;rut\n'+('X'.repeat(1048576)),'people']])assert.throws(()=>parseCsv(csv,kind),e=>e.status===400);
 assert.equal(parseCsv('name;rut\nA;B;C','people')[0].parse_error,'Cantidad de columnas distinta de la cabecera');
});
