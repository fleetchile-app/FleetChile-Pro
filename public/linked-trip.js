(function(){
 let opened=false,active=false,identity=null,token='',context='';
 window.isLinkedTripCurrent=()=>active&&Auth.user===identity&&Auth.token===token&&(localStorage.getItem('fleet_company_context')||'')===context;
 window.stopLinkedTrip=()=>{
  if(!active)return;active=false;
  document.getElementById('drawer').classList.add('hidden');
  document.getElementById('drawerBody').innerHTML='';
 };
 window.addEventListener?.('storage',event=>{
  if(!active||!['fleet_token','fleet_company_context'].includes(event.key)||window.isLinkedTripCurrent())return;
  window.stopLinkedTrip();
  document.getElementById('drawer').classList.remove('hidden');
  document.getElementById('drawerBody').innerHTML='<div class="card" role="alert"><h2>Sesión o empresa modificada</h2><p>Vuelve a abrir el viaje desde la plataforma para consultar su contexto vigente.</p><a class="secondary" href="/">Ir a la plataforma</a></div>';
 });
 window.openLinkedTrip=async function(){
  const params=new URLSearchParams(window.location.search);
  if(opened||!params.has('trip'))return;
  opened=true;
  const trip=params.get('trip'),company=params.get('company');
  const valid=value=>/^[1-9]\d*$/.test(value||'')&&Number.isSafeInteger(Number(value));
  const drawer=document.getElementById('drawer'),body=document.getElementById('drawerBody');
  window.linkedTripView=true;document.body.classList.add('linked-trip-view');
  drawer.classList.remove('hidden');
  const failure=message=>{
   body.innerHTML='<div class="card"><h2>No se pudo abrir el viaje</h2><p id="linkedTripError" role="alert"></p><a class="secondary" href="/">Ir a la plataforma</a></div>';
   document.getElementById('linkedTripError').textContent=message;
  };
  if(params.getAll('trip').length!==1||params.getAll('company').length!==1||!valid(trip)||!valid(company))return failure('El enlace del viaje no es válido.');
  document.getElementById('title').textContent='Detalle del viaje';
  document.title='Viaje #'+trip+' · FleetChile';
  const user=Auth.user;
  const platform=user?.actor_type==='platform'&&user.platform_membership_id;
  const legacy=user?.role_code==='admin'&&!user.membership_id&&!user.platform_membership_id;
  const currentCompany=platform?localStorage.getItem('fleet_company_context'):user?.company_id;
  if(!legacy&&String(currentCompany)!==company)return failure('La empresa activa no coincide con la del enlace. Selecciona la empresa correcta desde la plataforma y vuelve a abrirlo. No se ha cambiado tu contexto.');
  active=true;identity=user;token=Auth.token;context=localStorage.getItem('fleet_company_context')||'';
  try{await window.openTrip(Number(trip))}
  catch{failure('No se pudo consultar el viaje. Revisa tu sesión y permisos antes de reintentar.')}
 };
})();
