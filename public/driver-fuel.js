(function(){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const field=(name,label,type,attrs='')=>`<label>${label}<input name="${name}" type="${type}" ${attrs}></label>`;
 const terminal=ctx=>['Completado','Cancelado','Planificado'].includes(ctx.status);
 window.DriverFuel={async mount(trip,detail,ctx){
  const host=document.createElement('section');host.className='driver-card driver-fuel';host.dataset.driverFuel='';detail.append(host);
  host.innerHTML='<h2>Combustible del viaje</h2><p>Se vincula al camión asignado y a este viaje. Comprobante fotográfico obligatorio, también con tarjeta, convenio o suministro interno.</p><button class="driver-button" data-open-fuel>Registrar combustible</button><div data-fuel-form></div>';
  const open=host.querySelector('[data-open-fuel]');open.disabled=terminal(ctx);
  if(terminal(ctx)){open.insertAdjacentHTML('afterend','<p>No se registran nuevos abastecimientos en este estado.</p>');return;}
  open.onclick=async()=>{
   const box=host.querySelector('[data-fuel-form]'),draftId='draft-fuel-'+trip.id,owner=Auth.user?.id;
   const live=()=>host.isConnected&&Auth.user?.id===owner;
   open.disabled=true;
   try{
    const saved=await DriverMobile.draft(draftId);if(!live())return;
    if(saved?.payload?.client_key&&await DriverMobile.pending(saved.payload.client_key)){box.innerHTML='<p>Este comprobante ya está en Pendientes del teléfono. Sincronízalo o comprueba su recepción; no se enviará otro abastecimiento.</p>';return;}
    let photo=saved?.payload?.photo||'',clientKey=saved?.payload?.client_key||crypto.randomUUID(),writing=Promise.resolve(),busy=false;
    const context=saved?.context||{resource_version:ctx.resource_version,version:ctx.version};
    box.innerHTML=`<form class="driver-mobile-form"><p>Viaje ${esc(trip.trip_number)} · Camión ${esc(trip.patente||'#'+trip.truck_id)}</p>${field('date','Fecha real','date','required')}${field('liters','Litros','number','required min="0.01" step="0.01"')}${field('odometer_km','Odómetro (km)','number','required min="0" step="0.1"')}${field('total_clp','Total pagado / imputado (CLP)','number','required min="1" step="1"')}<label>Medio de pago<select name="payment_method" required><option value="">Seleccionar</option><option value="cash">Efectivo</option><option value="debit">Débito</option><option value="credit">Crédito</option><option value="agreement">Convenio / tarjeta de combustible</option><option value="internal">Suministro interno</option></select></label>${field('station','Estación / proveedor (opcional)','text','maxlength="200"')}${field('receipt_reference','Folio / referencia (opcional)','text','maxlength="160"')}<label>Fotografía del comprobante<input data-fuel-photo type="file" accept="image/jpeg,image/png,image/webp" capture="environment"></label><img data-fuel-preview alt="Comprobante de combustible" hidden><p data-fuel-message role="status" aria-live="polite"></p><button class="driver-button" type="submit">Guardar combustible</button></form>`;
    const form=box.querySelector('form'),message=box.querySelector('[data-fuel-message]'),preview=box.querySelector('[data-fuel-preview]'),button=form.querySelector('[type=submit]'),file=form.querySelector('[data-fuel-photo]');
    for(const [key,value]of Object.entries(saved?.payload||{}))if(form.elements[key])form.elements[key].value=value;
    if(!saved)form.elements.date.value=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
    const showPhoto=()=>{preview.hidden=!photo;if(photo)preview.src=photo;};showPhoto();
    if(saved)message.textContent='Borrador recuperado del teléfono. Revisa los datos y la fotografía.';
    const payload=()=>({...Object.fromEntries(new FormData(form)),photo,client_key:clientKey,...context});
    const save=()=>{const row={id:draftId,tripId:trip.id,kind:'fuel',state:'draft',context,payload:payload()};writing=writing.catch(()=>{}).then(async()=>{if(live())await DriverMobile.draft(draftId,row);});return writing;};
    form.addEventListener('input',()=>{if(!busy)save().then(()=>{if(live())message.textContent='Borrador guardado en este teléfono.';}).catch(e=>{if(live())message.textContent=e.message;});});
    file.onchange=async()=>{if(!file.files[0])return;busy=true;button.disabled=true;try{const next=await DriverMobile.photoData(file.files[0]);if(!live())return;photo=next;showPhoto();await save();message.textContent='Fotografía guardada en el borrador.';}catch(e){message.textContent=e.message;}finally{busy=false;button.disabled=false;}};
    form.onsubmit=async event=>{event.preventDefault();if(!live()||busy)return;busy=true;button.disabled=true;
     try{
      const current=DriverMobile.context(trip.id)||ctx;if(terminal(current))throw Error('El viaje está cerrado. Conserva el borrador y consulta a operaciones.');
      if(!photo)throw Error('Fotografía el comprobante antes de guardar, cualquiera sea el medio de pago.');
      await save();const b=payload();b.liters=Number(b.liters);b.odometer_km=Number(b.odometer_km);b.total_clp=Number(b.total_clp);
      form.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);
      const result=await DriverMobile.fuel(trip.id,b);if(!live())return;
      message.textContent=result.pending?'Guardado en este teléfono; falta confirmación. Usa Sincronizar pendientes. No vuelvas a registrar el mismo comprobante.':'Combustible, costo y fotografía recibidos y vinculados al viaje.';
      form.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);
      if(!result.pending){open.disabled=false;open.textContent='Registrar otro abastecimiento';}
     }catch(e){if(live()){message.textContent=e.message;form.querySelectorAll('input,select,button').forEach(el=>el.disabled=false);}}finally{busy=false;}
    };
   }catch(e){if(live()){box.textContent=e.message;open.disabled=false;}}
  };
 }};
})();
