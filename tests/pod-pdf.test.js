'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const {generatePodPdf,normalizeEvidence}=require('../pod-pdf');
const trip={id:7,company_id:10,trip_number:'V-DEMO-7',origin:'Aserradero demostración',destination:'Bodega demostración',distance_km:'512.75',driver_name:'Conductor actual',patente:'AA1111',planned_departure:'2026-10-30T08:00:00Z',planned_arrival:'2026-10-30T16:00:00Z',actual_departure:'2026-10-30T08:15:00Z'};
const proof={id:3,load_id:9,cargo:'Carga de madera - datos de demostración',client_name:'Cliente ficticio',weight_kg:1000,load_origin:'Aserradero demostración',load_destination:'Bodega demostración',recipient_name:'Receptor ficticio',delivered_at:'2026-10-30T16:20:00Z',created_by_name:'Conductor ficticio',notes:'Muestra técnica. No es un comprobante de una entrega real.'};
test('comprobante usa datos registrados, separa tiempos, no presume conformidad ni distancia real',()=>{
 const pdf=generatePodPdf({trip,proof,identity:{legal_name:'Empresa ficticia',version:2},documentId:'demostracion',emittedAt:'2026-10-30T18:00:00Z'}),text=pdf.toString('latin1');
 assert.match(text,/V-DEMO-7/);assert.match(text,/512,75 km/);assert.match(text,/8 h 0 min/);assert.match(text,/8 h 5 min/);assert.match(text,/Sin firma almacenada verificable/);assert.match(text,/no se presume recepción conforme/);assert.match(text,/no verificados en este/);assert.match(text,/Asignación actual al emitir/);assert.doesNotMatch(text,/\/Evidence\d+ /);
 const absent=generatePodPdf({trip:{...trip,distance_km:null,actual_departure:null},proof:{...proof,notes:'X'.repeat(6000)+' FIN_NOTAS'},identity:{},documentId:'x'}).toString('latin1');assert.match(absent,/FIN_NOTAS/);assert.doesNotMatch(absent,/0 km/);assert.match(absent,/No verificable/);assert.ok((absent.match(/Pagina \d+ de/g)||[]).length>1);
});
test('historial se usa sin presentar el conductor o distancia actuales como los de la entrega',()=>{
 const pdf=generatePodPdf({trip,proof,identity:{},documentId:'hist',resources:{version:2,effective_at:'2026-10-29T08:00:00Z',snapshot:{driver:{name:'Conductora histórica'},truck:{patente:'BB2222'}}},plan:{version:1,plan:{distance_meters:450000,departure:trip.planned_departure,arrival:trip.planned_arrival,stops:[]}}}).toString('latin1');
 assert.match(pdf,/Conductora histórica/);assert.match(pdf,/BB2222/);assert.match(pdf,/450 km/);assert.doesNotMatch(pdf,/Conductor actual|AA1111|512,75/);
});
test('normaliza PNG y JPEG y rechaza bytes inválidos, formato mentido o contenido vectorial',async()=>{
 const image=await sharp({create:{width:100,height:50,channels:4,background:'#fff0'}}).png().toBuffer(),out=await normalizeEvidence(image,'image/png');const meta=await sharp(out.jpeg).metadata();assert.equal(meta.format,'jpeg');assert.equal(meta.hasAlpha,false);assert.equal(meta.exif,undefined);
 for(const [b,m] of [[image,'image/jpeg'],[Buffer.from('no-image'),'image/png'],[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),'image/png']])await assert.rejects(normalizeEvidence(b,m),e=>e.status===503);
});
test('PDF incluye logo, firma y fotografía debajo, sin alterar los originales',async()=>{
 const image=async svg=>sharp(Buffer.from(svg)).png().toBuffer();
 const logo=await sharp(Buffer.from('<svg width="360" height="100" xmlns="http://www.w3.org/2000/svg"><rect width="360" height="100" fill="#23634c"/><text x="18" y="62" font-size="28" fill="white">TRANSPORTES DEMO</text></svg>')).jpeg().toBuffer();
 const signature=await image('<svg width="700" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="700" height="160" fill="white"/><path d="M40 110 Q90 20 110 100 T200 70 Q250 140 290 80 T390 80 L470 60 L430 120 L590 80" fill="none" stroke="#173b5d" stroke-width="4"/><text x="20" y="150" font-size="15">FIRMA SINTETICA - SOLO DEMOSTRACION</text></svg>');
 const photo=await image('<svg width="1000" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="600" fill="#e6eef4"/><rect x="70" y="160" width="860" height="340" fill="#b4c9d5"/><path d="M80 500 L500 40 L920 500" fill="none" stroke="#173b5d" stroke-width="16"/><text x="130" y="350" font-size="42" fill="#173b5d">RESPALDO DE DEMOSTRACION</text><text x="190" y="420" font-size="26">No es evidencia de una entrega real</text></svg>');
 const original=Buffer.from(signature),images=[{id:1,type:'signature',...await normalizeEvidence(signature,'image/png')},{id:2,type:'photo',...await normalizeEvidence(photo,'image/png')}];
 const pdf=generatePodPdf({trip,proof,identity:{company_id:10,legal_name:'Transportes Demostración SpA',display_name:'Transportes Demo',rut:'RUT de demostración',palette:'forest',version:2,contact_email:'operaciones@example.invalid',logo,logo_width:360,logo_height:100},images,documentId:'DEMO-POD-7-3',emittedAt:'2026-10-30T18:00:00Z'}),text=pdf.toString('latin1');
 assert.equal((text.match(/\/Subtype \/Image/g)||[]).length,3);assert.match(text,/\/Evidence0/);assert.match(text,/\/Evidence1/);assert.deepEqual(signature,original);assert.match(text,/Firma de recepción/);assert.match(text,/Fotografía \/ respaldo adjunto/);
 if(process.env.FLEETCHILE_POD_PDF_REVIEW_DIR){fs.mkdirSync(process.env.FLEETCHILE_POD_PDF_REVIEW_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.FLEETCHILE_POD_PDF_REVIEW_DIR,'comprobante-entrega-demo.pdf'),pdf);}
});
