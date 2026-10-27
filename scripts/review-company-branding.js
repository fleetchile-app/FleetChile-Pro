'use strict';
// Synthetic, offline-only PDF fixture for visual QA. Never opens the application/DB.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),sharp=require('sharp');
const {generateDriverPdf}=require('../driver-pdf');
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleetchile-branding-review-'));
 const logo=await sharp({create:{width:240,height:80,channels:3,background:'#23634c'}}).jpeg().toBuffer();
 const identity={company_id:1,legal_name:'Transportes Ejemplo SpA',display_name:'Transportes Ejemplo',rut:'RUT de prueba',version:1,palette:'forest',contact_name:'Coordinación de prueba',contact_email:'operaciones@example.invalid',contact_phone:'+56 9 0000 0000',logo,logo_width:240,logo_height:80};
 const pdf=generateDriverPdf({identity,documentId:'00000000-0000-4000-8000-000000000001',emittedAt:new Date('2026-10-27T12:00:00Z'),driver:{name:'María Muñoz — Ejemplo',rut:'RUT de prueba',email:'conductor@example.invalid'},licenses:[{classes:['A4','A5'],issued_date:'2025-01-01',printed_expiry:'2027-01-01',effective_expiry:'2027-01-01',current:true}],trips:Array.from({length:45},(_,i)=>({trip_number:'DEMO-'+(i+1),status:'Completado',origin:'Origen de prueba',destination:'Destino de prueba'})),events:[{event_date:'2026-10-01',event_type:'note',notes:'Registro ficticio para comprobar estilo y paginación. No corresponde a un trabajador real.'}]});
 fs.writeFileSync(path.join(dir,'ficha-conductor-ejemplo.pdf'),pdf);
 console.log(dir);
}
main().catch(e=>{console.error(e);process.exitCode=1});
