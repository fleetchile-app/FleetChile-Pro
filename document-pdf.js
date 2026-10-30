'use strict';
const {PALETTES}=require('./company-branding');
const TEMPLATE_VERSION='company-a4-v1';
function pdfText(value){return String(value??'').replace(/[—–]/g,'-').replace(/[^\x20-\xff]/g,'?').replace(/([\\()])/g,'\\$1');}
function clip(value,width,size){
 const s=String(value||'');let length=0,result='';
 for(const char of s){const unit=/[WM@%]/.test(char)?1:/[milI .,:;!'|]/.test(char)?.35:.7;length+=unit*size;if(length>width-3*size*.7)return result+'...';result+=char;}
 return result;
}
function rgb(hex){return [1,3,5].map(i=>(parseInt(hex.slice(i,i+2),16)/255).toFixed(3)).join(' ');}
function wrapPdfText(value,width=500,size=10){
 const measure=s=>Array.from(s).reduce((n,c)=>n+(/[WM@%mw]/.test(c)?1:/[ilI .,:;!'|]/.test(c)?.3:.7)*size,0);
 const lines=[];let line='';
 for(const word of String(value??'').split(/\s+/)){
  if(!word)continue;
  if(measure(word)>width){if(line){lines.push(line);line='';}let chunk='';for(const c of word){if(measure(chunk+c)>width){lines.push(chunk);chunk='';}chunk+=c;}line=chunk;}
  else if(!line)line=word;else if(measure(line+' '+word)<=width)line+=' '+word;else{lines.push(line);line=word;}
 }
 if(line||!lines.length)lines.push(line);return lines;
}
function paginate(blocks,sections,limit){
 const pages=[];let page=[],section='';
 const next=()=>{if(page.length)pages.push(page);page=section?[section+' (continuación)']:[];};
 blocks.forEach((block,index)=>{
  if(sections.includes(block[0])){section=block[0];if(page.length+1+Math.min(2,blocks[index+1]?.length||0)>limit){if(page.length)pages.push(page);page=[];}}
  if(block.length<=limit-1&&page.length+block.length>limit)next();
  for(const line of block){if(page.length>=limit)next();if(line||page.length)page.push(line);}
 });
 if(page.length)pages.push(page);return pages.length?pages:[[]];
}
// Reusable A4 layout. All strings are escaped, logos are normalized server-side JPEGs.
function generateDocumentPdf({title,lines=[],blocks,identity={},documentId='',emittedAt=new Date(),sections=[],visualPages=[],templateVersion=TEMPLATE_VERSION}){
 const pageWidth=595.28,pageHeight=841.89,textPages=paginate(blocks||lines.map(line=>[line]),sections,39),pages=[...textPages,...visualPages.map(()=>[])];
 const objects=[],add=v=>{objects.push(v);return objects.length};
 const catalog=add('<< /Type /Catalog /Pages 2 0 R >>'),pagesObj=add('');
 const font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
 const bold=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
 const color=rgb(PALETTES[identity.palette]||PALETTES.ocean),ids=[];
 let image=null;
 if(identity.logo&&identity.logo_width>0&&identity.logo_height>0){
  const bytes=Buffer.from(identity.logo);
  image=add(`<< /Type /XObject /Subtype /Image /Width ${identity.logo_width} /Height ${identity.logo_height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`);
 }
 const text=(value,x,y,size=10,weight='F1',fill='0.10 0.18 0.26')=>`${fill} rg BT /${weight} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfText(value)}) Tj ET\n`;
 for(let page=0;page<pages.length;page++){
  let stream=`${color} rg 0 831 ${pageWidth} 11 re f\n`;
  stream+=text(clip(identity.display_name||identity.legal_name||'FleetChile',image?395:515,15),40,797,15,'F2',color);
  stream+=text(clip(identity.legal_name||'Control de flota',image?395:515,9),40,780,9);
  stream+=text(identity.rut?`RUT: ${clip(identity.rut,300,9)}`:'FleetChile Pro',40,765,9);
  if(image){const scale=Math.min(104/identity.logo_width,47/identity.logo_height),w=identity.logo_width*scale,h=identity.logo_height*scale;stream+=`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${(555-w).toFixed(2)} ${(807-h).toFixed(2)} cm /Logo Do Q\n`;}
  stream+=`${color} RG 1 w 40 751 m 555 751 l S\n`;
  stream+=text(title,40,730,14,'F2');
  stream+=text(`Documento: ${documentId||'Vista previa'} | Emitido UTC: ${new Date(emittedAt).toISOString().slice(0,16).replace('T',' ')}`,40,710,8);
  stream+=text(`Plantilla: ${templateVersion} | Identidad: v${identity.version||0}`,40,696,8);
  let extraResources='';
  const visual=visualPages[page-textPages.length];
  if(visual){
   for(const line of visual.text||[])stream+=text(line.value,line.x??47,line.y,line.size||10,line.bold?'F2':'F1');
   for(const [index,item] of (visual.images||[]).entries()){
    const bytes=Buffer.from(item.jpeg),name='Evidence'+index;
    const object=add(`<< /Type /XObject /Subtype /Image /Width ${item.width} /Height ${item.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`);
    extraResources+=`/${name} ${object} 0 R `;
    const scale=Math.min(item.box.width/item.width,item.box.height/item.height),w=item.width*scale,h=item.height*scale;
    const x=item.box.x+(item.box.width-w)/2,y=item.box.y+(item.box.height-h)/2;
    stream+=`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q\n`;
   }
  }
  pages[page].forEach((line,i)=>{
   const y=674-i*15,section=sections.includes(line.replace(' (continuación)',''));
   if(section){stream+=`0.92 0.95 0.98 rg 40 ${y-4} 515 16 re f\n`;stream+=text(line,47,y,10,'F2',color);}
   else{if(i%2===0&&line)stream+=`0.98 0.985 0.99 rg 40 ${y-4} 515 15 re f\n`;stream+=text(line,47,y,10);}
  });
  stream+='0.80 0.85 0.90 RG 0.5 w 40 64 m 555 64 l S\n';
  stream+=text(clip([identity.contact_name,identity.contact_email,identity.contact_phone].filter(Boolean).join(' | '),515,8),40,49,8);
  stream+=text(clip(identity.legal_name||'FleetChile',400,8),40,34,8);
  stream+=text(`Pagina ${page+1} de ${pages.length}`,460,34,8);
  const content=add(`<< /Length ${Buffer.byteLength(stream,'latin1')} >>\nstream\n${stream}endstream`);
  ids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> ${image||extraResources?`/XObject << ${image?`/Logo ${image} 0 R `:''}${extraResources}>>`:''} >> /Contents ${content} 0 R >>`));
 }
 objects[pagesObj-1]=`<< /Type /Pages /Kids [${ids.map(id=>`${id} 0 R`).join(' ')}] /Count ${ids.length} >>`;
 let output='%PDF-1.4\n%\xE2\xE3\xCF\xD3\n',offsets=[0];
 objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(output,'latin1'));output+=`${i+1} 0 obj\n${object}\nendobj\n`});
 const xref=Buffer.byteLength(output,'latin1');output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 for(const offset of offsets.slice(1))output+=`${String(offset).padStart(10,'0')} 00000 n \n`;
 output+=`trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(output,'latin1');
}
module.exports={generateDocumentPdf,TEMPLATE_VERSION,wrapPdfText};
