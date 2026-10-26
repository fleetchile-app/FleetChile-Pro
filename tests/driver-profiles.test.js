'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','driver-profile-api.js'),'utf8');
test('expone superficie de candidatos, alta, detalle, eventos y PDF',()=>{
 for(const route of ['/api/fleet/drivers/candidates','/api/fleet/drivers/onboarded','/api/fleet/drivers','/api/fleet/drivers/:id','/api/fleet/drivers/:id/events','/api/fleet/drivers/:id/pdf'])assert.match(source,new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.match(source,/app\.post\('\/api\/drivers',manage,onboardDriver\)/);
 assert.match(source,/registerDriverProfileRoutes/);assert.match(source,/requirePermission\('drivers\.manage'\)/);
});
test('preserva RUT canónico, valida condiciones y crea suspensión canónica',()=>{
 assert.match(source,/p\.rut/);assert.match(source,/contract_active/);assert.match(source,/condition_active/);assert.match(source,/effective_expiry/);assert.match(source,/insert into person_conditions/);assert.match(source,/event_type/);
 assert.doesNotMatch(source,/diagnosis|diagnostico|medical_diagnosis/i);
});
test('alta es transaccional y bloquea filas antes de crear o marcar conductor',()=>{
 assert.match(source,/await db\.query\('BEGIN'\)/);assert.match(source,/for update/);assert.match(source,/operational_registered_at=now\(\)/);assert.match(source,/insert into drivers/);assert.match(source,/COMMIT/);assert.match(source,/ROLLBACK/);
});
test('API no conserva SQL roto ni pierde identidad, fechas o cache de PDF',()=>{
 assert.doesNotMatch(source,/dummy\.(name|rut)/);
 assert.match(source,/effective_expiry::text/);
 assert.match(source,/El conductor ya está registrado operacionalmente/);
 assert.match(source,/p\.id person_id/);
 assert.match(source,/Cache-Control.*private, no-store/);
 assert.match(source,/person_conditions/);
});
