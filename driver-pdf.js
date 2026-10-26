'use strict';

// Small dependency-free PDF writer. Text is deliberately limited to WinAnsi
// characters so generated documents remain readable without external fonts.
function pdfText(value){
 return String(value??'').replace(/[—–]/g,'-').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e]/g,'?').replace(/([\\()])/g,'\\$1');
}
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
function generateDriverPdf({driver={},trips=[],events=[],licenses=[]}={}){
 const rawLines=[
  `Fecha de generacion (UTC): ${new Date().toISOString().slice(0,10)}`,
  `Nombre: ${driver.name||'—'}`,
  `Usuario: ${driver.username||driver.email||'—'}`,
  `RUT: ${driver.rut||'—'}`,
  `Version de perfil: ${driver.profile_version??1}`,
  '',
  'Licencias',
  ...(licenses.length?licenses.map(x=>`${x.classes||'—'} | emitida ${pdfDate(x.issued_date)} | impresa ${pdfDate(x.printed_expiry)} | efectiva hasta ${pdfDate(x.effective_expiry)} | ${x.current===false?'historica':'vigente'}`):['Sin licencias registradas']),
  '',
  'Historial operacional',
  ...(trips.length?trips.map(x=>`${x.trip_number||'Viaje'} | ${x.status||'—'} | ${x.origin||'—'} -> ${x.destination||'—'}`):['Sin viajes registrados']),
  '',
  'Eventos de perfil',
  ...(events.length?events.map(x=>`${pdfDate(x.event_date)} | ${x.event_type||'—'} | ${pdfDate(x.ends_on)} | ${x.amount_clp??'—'} | ${x.notes||''}`):['Sin eventos registrados'])
 ];
 const lines=rawLines.flatMap(line=>wrapLine(line,55));
 const pageHeight=792,pageWidth=612,top=748,lineHeight=14,perPage=49,pages=[];
 for(let i=0;i<lines.length;i+=perPage)pages.push(lines.slice(i,i+perPage));
 const objects=[];
 const add=value=>{objects.push(value);return objects.length};
 const catalog=add('<< /Type /Catalog /Pages 2 0 R >>');
 const pagesObj=add('');
 const font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
 const pageIds=[];
 for(let pageIndex=0;pageIndex<pages.length;pageIndex++){
  const pageLines=pages[pageIndex];
  let stream='BT\n/F1 10 Tf\n';
  stream+=`1 0 0 1 42 774 Tm (${pdfText('FleetChile - Ficha operacional de conductor')}) Tj\n`;
  pageLines.forEach((line,index)=>{stream+=`1 0 0 1 42 ${top-index*lineHeight} Tm (${pdfText(line)}) Tj\n`});
  stream+=`1 0 0 1 42 28 Tm (${pdfText(`Pagina ${pageIndex+1} de ${pages.length}`)}) Tj\n`;
  stream+='ET';
  const content=add(`<< /Length ${Buffer.byteLength(stream,'latin1')} >>\nstream\n${stream}\nendstream`);
  pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
 }
 objects[pagesObj-1]=`<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
 let output='%PDF-1.4\n%\xE2\xE3\xCF\xD3\n',offsets=[0];
 objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(output,'latin1'));output+=`${index+1} 0 obj\n${object}\nendobj\n`});
 const xref=Buffer.byteLength(output,'latin1');output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 for(let i=1;i<offsets.length;i++)output+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
 output+=`trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(output,'latin1');
}
module.exports={generateDriverPdf,wrapLine};
