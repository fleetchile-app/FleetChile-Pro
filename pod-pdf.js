'use strict';
const sharp=require('sharp');
const {generateDocumentPdf,wrapPdfText}=require('./document-pdf');
const TEMPLATE_VERSION='pod-receipt-a4-v1';
const value=v=>v===null||v===undefined||v===''?'No registrado':String(v);
function date(v){const d=v?new Date(v):null;return d&&Number.isFinite(d.getTime())?d.toISOString().slice(0,19).replace('T',' ')+' UTC':'No registrada';}
function duration(start,end){const a=Date.parse(start),b=Date.parse(end);if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)return 'No verificable';const m=Math.round((b-a)/60000);return Math.floor(m/60)+' h '+m%60+' min';}
function distance(v){return v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v).toLocaleString('es-CL',{maximumFractionDigits:2})+' km':'No registrada';}
async function normalizeEvidence(bytes,mime){
 try{
  const image=sharp(bytes,{limitInputPixels:16000000,failOn:'warning'}),meta=await image.metadata();
  if(!['png','jpeg'].includes(meta.format)||(meta.pages||1)!==1||!meta.width||!meta.height||mime!=='image/'+(meta.format==='jpeg'?'jpeg':'png'))throw Error('format');
  const {data,info}=await image.rotate().resize({width:1800,height:1800,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).toColourspace('srgb').jpeg({quality:88}).toBuffer({resolveWithObject:true});
  return {jpeg:data,width:info.width,height:info.height};
 }catch{throw Object.assign(Error('La evidencia no es una imagen válida para el comprobante'),{status:503});}
}
function generatePodPdf({trip,proof,identity,resources,plan,images=[],documentId,emittedAt=new Date()}){
 const historical=Boolean(resources),assignment=resources?.snapshot;
 const driver=historical?assignment?.driver?.name:trip.driver_name;
 const truck=historical?assignment?.truck?.patente:trip.patente;
 const trailer=historical?assignment?.trailer?.patente:trip.trailer_patente;
 const departure=plan?.plan?.departure||trip.planned_departure,arrival=plan?.plan?.arrival||trip.planned_arrival;
 const plannedDistance=plan?(plan.plan.distance_meters==null?null:plan.plan.distance_meters/1000):(Number(trip.distance_km)>0||trip.itinerary_version>0||trip.planned_route_snapshot_id?trip.distance_km:null);
 const signature=images.find(f=>f.type==='signature'),photos=images.filter(f=>f.type==='photo');
 const sections=['Servicio y carga','Recursos y recorrido','Fechas y tiempos','Constancia de recepción','Observaciones y alcance'];
 const raw=[
  'Servicio y carga',`Viaje: ${value(trip.trip_number)} | Entrega POD #${proof.id} | Carga #${value(proof.load_id)}`,
  `Cliente asociado: ${value(proof.client_name)}`,`Carga: ${value(proof.cargo)} | Peso registrado: ${value(proof.weight_kg)} kg`,
  `Referencia de carga: ${value(proof.guide)}`,`Recogida de la carga: ${value(proof.load_origin)}`,`Entrega de la carga: ${value(proof.load_destination)}`,
  'Recursos y recorrido',`Conductor: ${value(driver)}`,`Camión: ${value(truck)} | Remolque: ${value(trailer)}`,
  historical?`Asignación histórica v${resources.version}, efectiva desde ${date(resources.effective_at)}`:'Asignación actual al emitir. No existe una asignación histórica verificable para esta recepción.',
  `Viaje (cabecera actual): ${value(trip.origin)} -> ${value(trip.destination)}`,
  `Distancia planificada del viaje completo: ${distance(plannedDistance)}`,
  plan?`Plan histórico v${plan.version}: ${plan.plan.stops?.map(s=>s.location?.name||s.key).join(' -> ')||'Sin detalle'}`:'Sin plan histórico versionado para la recepción. Se muestran los datos planificados actuales.',
  'Fechas y tiempos',`Salida planificada del viaje: ${date(departure)}`,`Llegada planificada del viaje: ${date(arrival)}`,
  `Duración planificada total: ${duration(departure,arrival)}`,`Salida real registrada del viaje: ${date(trip.actual_departure)}`,
  `Recepción registrada: ${date(proof.delivered_at)}`,`Tiempo desde salida real hasta esta recepción: ${duration(trip.actual_departure,proof.delivered_at)}`,
  `Finalización real del viaje completo: ${date(trip.actual_arrival)}`,
  'Distancia real recorrida y tiempo exclusivo de conducción: no verificados en este comprobante.',
  'Constancia de recepción',`Receptor: ${value(proof.recipient_name)} | RUT: ${value(proof.recipient_rut)}`,
  `Estado del registro: Cerrado | Registrado por: ${value(proof.created_by_name)}`,
  `Firma: ${signature?'Evidencia adjunta en página siguiente':'Sin firma almacenada verificable'}. Fotografías: ${photos.length}.`,
  'Observaciones y alcance',proof.notes?'Observaciones registradas: '+proof.notes:'Sin observaciones registradas. Esto no presume conformidad sin reservas.',
  'La firma acredita la recepción registrada; no se presume recepción conforme ni firma electrónica avanzada.',
  'Comprobante operacional interno. No es una guía de despacho tributaria ni un DTE.',
  'Datos consultados e identidad corporativa vigentes a la fecha de emisión; los originales no se modifican.'
 ];
 const visualPages=[];
 if(signature||photos.length){
  const receiver=wrapPdfText('Receptor: '+value(proof.recipient_name),490,9),page={text:[{value:'Evidencias de recepción - POD #'+proof.id,y:672,bold:true},...receiver.slice(0,2).map((v,i)=>({value:v+(i===1&&receiver.length>2?'... (ver resumen)':''),y:651-i*12,size:9})),{value:'Recepción: '+date(proof.delivered_at),y:620,size:9}],images:[]};
  page.text.push({value:'Firma de recepción',y:602,bold:true});
  if(signature){page.images.push({...signature,box:{x:47,y:464,width:500,height:128}});page.text.push({value:'Firma original #'+signature.id+' - integridad SHA-256 verificada',y:448,size:9});}
  else page.text.push({value:'Sin firma almacenada verificable. No se recrea una firma.',y:567});
  const photo=photos[0];page.text.push({value:'Fotografía / respaldo adjunto',y:421,bold:true});
  if(photo){page.images.push({...photo,box:{x:47,y:108,width:500,height:296}});page.text.push({value:'Fotografía original #'+photo.id+' - integridad SHA-256 verificada',y:91,size:9});}
  else page.text.push({value:'Sin fotografía adjunta.',y:390});
  visualPages.push(page);
  for(const photo of photos.slice(1))visualPages.push({text:[{value:'Respaldo adicional - POD #'+proof.id,y:672,bold:true},{value:'Fotografía original #'+photo.id+' - integridad SHA-256 verificada',y:91,size:9}],images:[{...photo,box:{x:47,y:108,width:500,height:530}}]});
 }
 return generateDocumentPdf({title:'Comprobante de entrega / POD',blocks:raw.map(line=>wrapPdfText(line)),sections,identity,documentId,emittedAt,visualPages,templateVersion:TEMPLATE_VERSION});
}
module.exports={generatePodPdf,normalizeEvidence,TEMPLATE_VERSION};
