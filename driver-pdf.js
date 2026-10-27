'use strict';

// Domain content is separate from the reusable, branded A4 PDF layout.
function pdfDate(value){
 if(value===null||value===undefined||value==='')return '—';
 if(value instanceof Date)return Number.isNaN(value.getTime())?'—':value.toISOString().slice(0,10);
 return String(value).slice(0,10);
}
function wrapLine(value,width=55){
 const text=String(value??'');if(!text)return [''];
 const out=[];let current='';
 for(const word of text.split(/\s+/)){
  if(!word)continue;
  if(word.length>width){
   if(current){out.push(current);current=''}
   for(let i=0;i<word.length;i+=width)out.push(word.slice(i,i+width));
  }else if(!current)current=word;
  else if(current.length+1+word.length<=width)current+=` ${word}`;
  else{out.push(current);current=word}
 }
 if(current||!out.length)out.push(current);return out;
}
function generateDriverPdf({driver={},trips=[],events=[],licenses=[],identity={},documentId='',emittedAt=new Date()}={}){
 const rawLines=[
  `Fecha de generacion (UTC): ${new Date(emittedAt).toISOString().slice(0,10)}`,
  `Nombre: ${driver.name||'—'}`,
  `Usuario: ${driver.username||driver.email||'—'}`,
  `RUT: ${driver.rut||'—'}`,
  `Version de perfil: ${driver.profile_version??1}`,
  '',
  'Licencias',
  ...(licenses.length?licenses.map(x=>`${Array.isArray(x.classes)?x.classes.join(', '):x.classes||'—'} | emitida ${pdfDate(x.issued_date)} | impresa ${pdfDate(x.printed_expiry)} | efectiva hasta ${pdfDate(x.effective_expiry)} | ${x.current===false?'histórica':'registro actual'}`):['Sin licencias registradas']),
  '',
  'Historial operacional',
  ...(trips.length?trips.map(x=>`${x.trip_number||'Viaje'} | ${x.status||'—'} | ${x.origin||'—'} -> ${x.destination||'—'}${x.currently_assigned===false?' | Asignacion anterior':x.currently_assigned===true?' | Asignacion actual':''}`):['Sin viajes registrados']),
  '',
  'Eventos de perfil',
  ...(events.length?events.map(x=>`${pdfDate(x.event_date)} | ${{fine:'Multa',suspension:'Suspensión',condition:'Condición laboral',note:'Nota'}[x.event_type]||x.event_type||'—'} | Término: ${pdfDate(x.ends_on)} | Monto CLP: ${x.amount_clp??'—'} | ${x.notes||''}`):['Sin eventos registrados'])
 ];
 const {wrapPdfText}=require('./document-pdf'),blocks=rawLines.map(line=>wrapPdfText(line));
 return require('./document-pdf').generateDocumentPdf({title:identity.company_id?'Ficha operacional de conductor':'FleetChile - Ficha operacional de conductor',
  blocks,identity,documentId,emittedAt,sections:['Licencias','Historial operacional','Eventos de perfil']});
}
module.exports={generateDriverPdf,wrapLine};
