const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

// Ejecuta el script real con una superficie DOM mínima y sin servicios externos.
function deliverySurface({geolocation,failPost=false,load={id:8,cargo:'Carga de prueba'},drawn=true,storage=new Map(),user={id:1,company_id:10,driver_id:4},fetchDelivery,unavailableStorage=false,readerClass}={}){
  const elements=new Map();
  for(const selector of ['.delivery-photo','.delivery-preview','.clear-signature','.submit-delivery','.delivery-error','.signature-host','.driver-hint']){
    elements.set(selector,{hidden:true,disabled:false,files:[],append(){}});
  }
  for(const [selector,value] of [['.delivery-recipient','Receptor de prueba'],['.delivery-rut',''],['.delivery-notes','']])elements.set(selector,{value});
  const card={innerHTML:'',querySelector:selector=>elements.get(selector),insertAdjacentHTML(){}};
  const context2d={fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){}};
  const canvas={width:0,height:0,getContext:()=>context2d,addEventListener(){},toDataURL:()=> 'data:image/png;base64,firma-de-prueba'};
  const calls=[];
  let sequence=0;
  const navigator=geolocation?{geolocation}:{};
  const sandbox={
    document:{getElementById:()=>({querySelector:()=>null}),createElement:tag=>tag==='canvas'?canvas:card},
    window:{},navigator,Auth:{user},FileReader:readerClass,crypto:{randomUUID:()=> `submission-de-prueba-${++sequence}`},
    sessionStorage:{getItem:key=>{if(unavailableStorage)throw Error('Storage bloqueado');return storage.get(key)||null},setItem:(key,value)=>{if(unavailableStorage)throw Error('Storage bloqueado');storage.set(key,value)},removeItem:key=>{if(unavailableStorage)throw Error('Storage bloqueado');storage.delete(key)}},
    async fetch(url,options){
      calls.push({url,payload:JSON.parse(options.body)});
      if(fetchDelivery)return fetchDelivery(calls.at(-1),calls.length);
      return {ok:!failPost,status:failPost?503:201,json:async()=>failPost?{error:'Servicio temporalmente no disponible'}:{id:21}};
    }
  };
  const source=fs.readFileSync(path.join(__dirname,'..','public','driver.js'),'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/,'window.testDeliveryForm=deliveryForm;window.testEndSession=()=>sessionVersion++;window.testEndView=()=>viewVersion++;})();'),sandbox);
  // La firma se dibuja fuera del alcance de estas pruebas de envío y ubicación.
  const open=(selectedLoad=load,tripId=7)=>{
    const form=sandbox.window.testDeliveryForm(tripId,selectedLoad);
    canvas.value=()=>drawn?canvas.toDataURL():'';
    return form;
  };
  open();
  return {calls,elements,navigator,storage,open,endSession:sandbox.window.testEndSession,endView:sandbox.window.testEndView,submit:()=>elements.get('.submit-delivery').onclick()};
}

async function submitWithoutBlocking(surface){
  let timer;
  try{
    await Promise.race([
      surface.submit(),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('El envío POD quedó bloqueado')),500)})
    ]);
  }finally{clearTimeout(timer)}
}

test('POD no modifica la API nativa de geolocalización',()=>{
  const getCurrentPosition=()=>{};
  const surface=deliverySurface({geolocation:{getCurrentPosition}});
  assert.equal(surface.navigator.geolocation.getCurrentPosition,getCurrentPosition);
});

test('POD no se envía si la sesión cambia mientras espera ubicación',async()=>{
  let located;
  const surface=deliverySurface({geolocation:{getCurrentPosition(success){located=success}}});
  const pending=surface.submit();
  surface.endSession();
  located({coords:{latitude:-33.45,longitude:-70.66}});
  await pending;
  assert.equal(surface.calls.length,0);
});

test('POD no se envía al abandonar formulario mientras espera ubicación',async()=>{
  let located;
  const surface=deliverySurface({geolocation:{getCurrentPosition(success){located=success}}});
  const pending=surface.submit();surface.endView();
  located({coords:{latitude:-33.45,longitude:-70.66}});await pending;
  assert.equal(surface.calls.length,0);
});

test('POD no se envía si se cierra sesión mientras lee la fotografía',async()=>{
  let reader;
  const surface=deliverySurface({readerClass:class{constructor(){reader=this}readAsDataURL(){}}});
  surface.elements.get('.delivery-photo').files=[{name:'foto.jpg'}];
  const pending=surface.submit();surface.endSession();
  reader.result='data:image/jpeg;base64,prueba';reader.onload();await pending;
  assert.equal(surface.calls.length,0);
});

test('POD envía la entrega cuando obtiene ubicación',async()=>{
  let options;
  const surface=deliverySurface({geolocation:{getCurrentPosition(success,error,receivedOptions){options=receivedOptions;success({coords:{latitude:-33.45,longitude:-70.66}})}}});
  await submitWithoutBlocking(surface);
  assert.equal(surface.calls.length,1);
  assert.equal(surface.calls[0].url,'/api/driver/trips/7/deliveries');
  assert.equal(surface.calls[0].payload.load_id,8);
  assert.equal(surface.calls[0].payload.latitude,-33.45);
  assert.equal(surface.calls[0].payload.longitude,-70.66);
  assert.equal(options.timeout,3000);
});

for(const [reason,code] of [['permiso denegado',1],['posición no disponible',2],['timeout',3]]){
  test(`POD continúa sin coordenadas ante ${reason}`,async()=>{
    const surface=deliverySurface({geolocation:{getCurrentPosition(success,error){error({code})}}});
    await submitWithoutBlocking(surface);
    assert.equal(surface.calls.length,1);
    assert.equal('latitude' in surface.calls[0].payload,false);
    assert.equal('longitude' in surface.calls[0].payload,false);
  });
}

test('POD continúa si el navegador no soporta geolocalización',async()=>{
  const surface=deliverySurface();
  await submitWithoutBlocking(surface);
  assert.equal(surface.calls.length,1);
  assert.equal('latitude' in surface.calls[0].payload,false);
});

test('POD muestra el fallo de envío y permite reintentar',async()=>{
  const surface=deliverySurface({failPost:true,geolocation:{getCurrentPosition(success){success({coords:{latitude:-33.45,longitude:-70.66}})}}});
  await submitWithoutBlocking(surface);
  assert.equal(surface.calls.length,1);
  assert.equal(surface.elements.get('.submit-delivery').disabled,false);
  assert.equal(surface.elements.get('.delivery-error').hidden,false);
  assert.equal(surface.elements.get('.delivery-error').textContent,'Servicio temporalmente no disponible');
});

test('POD conserva submission al reintentar después de una respuesta perdida',async()=>{
  const surface=deliverySurface({fetchDelivery:async(call,attempt)=>{
    if(attempt===1)throw Error('Respuesta perdida');
    return {ok:true,json:async()=>({id:21,status:'CLOSED'})};
  }});
  await submitWithoutBlocking(surface);
  await submitWithoutBlocking(surface);
  assert.equal(surface.calls.length,2);
  assert.equal(surface.calls[0].payload.client_submission_id,surface.calls[1].payload.client_submission_id);
});

test('POD conserva solo el identificador al reabrir y lo elimina tras éxito',async()=>{
  const surface=deliverySurface({failPost:true});
  await submitWithoutBlocking(surface);
  const first=surface.calls[0].payload.client_submission_id;
  assert.deepEqual([...surface.storage.values()],[first]);
  surface.open();
  await submitWithoutBlocking(surface);
  assert.equal(surface.calls[1].payload.client_submission_id,first);
  const recovered=deliverySurface({storage:surface.storage});
  await submitWithoutBlocking(recovered);
  assert.equal(recovered.calls[0].payload.client_submission_id,first);
  assert.equal(surface.storage.size,0);
});

test('POD aísla los identificadores pendientes por usuario y empresa',async()=>{
  const storage=new Map();
  for(const user of [{id:1,company_id:10,driver_id:4},{id:2,company_id:10,driver_id:5},{id:1,company_id:20,driver_id:4}]){
    await submitWithoutBlocking(deliverySurface({storage,user,failPost:true}));
  }
  assert.equal(storage.size,3);
});

test('POD recupera DRAFT con identificador del servidor y firma almacenada sin inventar imagen',async()=>{
  const surface=deliverySurface({drawn:false,load:{id:8,cargo:'Carga',deliveries:[{status:'DRAFT',client_submission_id:'draft-servidor',recipient_name:'Receptor previo',recipient_rut:'',notes:'Borrador',evidence:[{type:'signature',exists:true}]}]}});
  await submitWithoutBlocking(surface);
  assert.equal(surface.calls.length,1);
  assert.equal(surface.calls[0].payload.client_submission_id,'draft-servidor');
  assert.equal(surface.calls[0].payload.recipient_name,'Receptor previo');
  assert.equal('signature' in surface.calls[0].payload,false);
});

test('POD exige firma nueva cuando la evidencia del borrador está ausente',async()=>{
  const surface=deliverySurface({drawn:false,load:{id:8,cargo:'Carga',deliveries:[{status:'DRAFT',client_submission_id:'draft-servidor',evidence:[{type:'signature',exists:false}]}]}});
  await submitWithoutBlocking(surface);
  assert.equal(surface.calls.length,0);
  assert.equal(surface.elements.get('.delivery-error').hidden,false);
});

test('POD no envía un borrador sin identificador de reanudación',async()=>{
  const surface=deliverySurface({load:{id:8,cargo:'Carga',deliveries:[{status:'DRAFT',evidence:[]}]}});
  await submitWithoutBlocking(surface);
  assert.equal(surface.calls.length,0);
});

test('POD evita solicitudes simultáneas por doble confirmación',async()=>{
  const finishes=[];
  const surface=deliverySurface({fetchDelivery:()=>new Promise(resolve=>{finishes.push(()=>resolve({ok:true,json:async()=>({id:21})}))})});
  const first=surface.submit();
  const second=surface.submit();
  try{assert.equal(surface.calls.length,1)}finally{finishes.forEach(finish=>finish())}
  await Promise.all([first,second]);
});

test('POD conserva el identificador en memoria si sessionStorage está bloqueado',async()=>{
  const surface=deliverySurface({unavailableStorage:true,failPost:true});
  await submitWithoutBlocking(surface);
  surface.open();
  await submitWithoutBlocking(surface);
  assert.equal(surface.calls.length,2);
  assert.equal(surface.calls[0].payload.client_submission_id,surface.calls[1].payload.client_submission_id);
});

test('POD usa identificadores distintos para otras cargas y viajes',async()=>{
  const surface=deliverySurface({failPost:true});
  await submitWithoutBlocking(surface);
  surface.open({id:9,cargo:'Otra carga'});
  await submitWithoutBlocking(surface);
  surface.open({id:8,cargo:'Otra carga'},20);
  await submitWithoutBlocking(surface);
  assert.equal(new Set(surface.calls.map(call=>call.payload.client_submission_id)).size,3);
  assert.equal(surface.storage.size,3);
});

test('POD no vuelve a enviar un formulario ya confirmado',async()=>{
  const surface=deliverySurface();
  await submitWithoutBlocking(surface);
  await submitWithoutBlocking(surface);
  assert.equal(surface.calls.length,1);
});
