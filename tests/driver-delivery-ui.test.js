const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

// Ejecuta el script real con una superficie DOM mínima y sin servicios externos.
function deliverySurface({geolocation,failPost=false}={}){
  const elements=new Map();
  for(const selector of ['.delivery-photo','.delivery-preview','.clear-signature','.submit-delivery','.delivery-error','.signature-host']){
    elements.set(selector,{hidden:true,disabled:false,files:[],append(){}});
  }
  for(const [selector,value] of [['.delivery-recipient','Receptor de prueba'],['.delivery-rut',''],['.delivery-notes','']])elements.set(selector,{value});
  const card={innerHTML:'',querySelector:selector=>elements.get(selector),insertAdjacentHTML(){}};
  const context2d={fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){}};
  const canvas={width:0,height:0,getContext:()=>context2d,addEventListener(){},toDataURL:()=> 'data:image/png;base64,firma-de-prueba'};
  const calls=[];
  const navigator=geolocation?{geolocation}:{};
  const sandbox={
    document:{getElementById:()=>({querySelector:()=>null}),createElement:tag=>tag==='canvas'?canvas:card},
    window:{},navigator,crypto:{randomUUID:()=> 'submission-de-prueba'},
    async fetch(url,options){
      calls.push({url,payload:JSON.parse(options.body)});
      return {ok:!failPost,status:failPost?503:201,json:async()=>failPost?{error:'Servicio temporalmente no disponible'}:{id:21}};
    }
  };
  const source=fs.readFileSync(path.join(__dirname,'..','public','driver.js'),'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/,'window.testDeliveryForm=deliveryForm;})();'),sandbox);
  sandbox.window.testDeliveryForm(7,{id:8,cargo:'Carga de prueba'});
  // La firma se dibuja fuera del alcance de estas pruebas de envío y ubicación.
  canvas.value=()=>canvas.toDataURL();
  return {calls,elements,navigator,submit:()=>elements.get('.submit-delivery').onclick()};
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
