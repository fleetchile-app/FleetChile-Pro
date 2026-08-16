const A=document.getElementById("app"),nav=document.getElementById("nav"),title=document.getElementById("title");let map;
const menus=[["dashboard","⌂","Dashboard"],["trucks","🚛","Camiones"],["drivers","👤","Conductores"],["routes","↗","Rutas"],["loads","▣","Cargas"],["maintenance","🔧","Mantenciones"],["fuel","⛽","Combustible"],["alerts","⚠","Alertas"],["reports","▥","Reportes"]];
nav.innerHTML=menus.map(x=>`<button data-v="${x[0]}">${x[1]} <span>${x[2]}</span></button>`).join("");nav.querySelectorAll("button").forEach(b=>b.onclick=()=>render(b.dataset.v));
const get=u=>fetch("/api/"+u).then(r=>r.json()),post=(u,o)=>fetch("/api/"+u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)}).then(r=>r.json());
const money=n=>new Intl.NumberFormat("es-CL",{style:"currency",currency:"CLP",maximumFractionDigits:0}).format(n||0);
const badge=s=>`<span class="badge ${/Pendiente|Borrador|Planificada|Mantención/.test(s)?"amber":/atras|error|crítico/i.test(s)?"red":""}">${s||""}</span>`;
function render(v="dashboard"){nav.querySelectorAll("button").forEach(b=>b.classList.toggle("active",b.dataset.v===v));title.textContent=menus.find(x=>x[0]===v)?.[2]||"FleetChile";window[v]();}
async function dashboard(){
 const [d,t,r,al]=await Promise.all([get("dashboard"),get("trucks"),get("routes"),get("alerts")]);
 A.innerHTML=`<div class="grid kpis">${k("Camiones",d.trucks,"base operativa")}${k("En ruta",d.enroute,"GPS activo")}${k("Cargas",d.loads,"operacionales")}${k("Alertas",d.alerts,"sin resolver")}${k("Combustible",money(d.fuel),"acumulado")}</div>
 <div class="grid two"><div class="card"><div style="display:flex;justify-content:space-between"><h3>Mapa operacional</h3><span class="live"><i></i> actualización automática</span></div><div id="map" class="map"></div></div>
 <div class="card"><h3>Centro de alertas</h3><div id="alerts">${al.filter(x=>!x.resolved).slice(0,5).map(x=>`<div class="alert"><b>${x.title}</b><br>${x.text}</div>`).join("")}</div>
 <div class="hero"><b>Control GPS</b><p>Selecciona un camión en el mapa para ver estado, velocidad, kilometraje y última posición. El botón de simulación mueve un camión demo.</p><button class="simulate" onclick="simulateGPS()">Simular GPS</button></div></div></div>
 <div class="card" style="margin-top:15px"><div style="display:flex;justify-content:space-between"><h3>Rutas activas</h3><button class="primary" onclick="openForm('routes')">+ Nueva ruta</button></div>${table(["Camión","Origen","Destino","Avance","Estado"],r,x=>[x.truck,x.origin,x.destination,`<div class="route-bar"><i style="width:${x.progress}%"></i></div><small>${x.progress}%</small>`,badge(x.status)])}</div>`;
 setTimeout(()=>makeMap(t),0);
}
function k(l,v,f){return `<div class="card"><div class="label">${l}</div><div class="value">${v}</div><div class="good">● ${f}</div></div>`}
function makeMap(ts){
 if(map){map.remove();map=null}
 map=L.map("map").setView([-36.5,-72.5],6);
 L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
 ts.filter(x=>x.lat&&x.lng).forEach(x=>{
  const marker=L.marker([x.lat,x.lng]).addTo(map);
  marker.bindPopup(`<b>${x.patente}</b><br>${x.driver||"Sin conductor"}<br>${x.status}<br>${x.location||""}<br><button onclick="openTruck(${x.id})">Ver ficha</button>`);
 });
}
async function openTruck(id){
 const ts=await get("trucks");const t=ts.find(x=>x.id==id);if(!t)return;
 const h=await get(`trucks/${id}/history`);
 document.getElementById("drawerBody").innerHTML=`<div class="live"><i></i> GPS ${t.lat&&t.lng?"conectado":"sin posición"}</div><h2>${t.patente}</h2><p>${t.tipo} · ${t.capacidad_t} t</p>
 <div class="metric-grid"><div class="metric"><small>Estado</small><b>${t.status}</b></div><div class="metric"><small>Velocidad última</small><b>${h[0]?.speed_kmh||0} km/h</b></div><div class="metric"><small>Kilometraje</small><b>${Number(t.km||0).toLocaleString("es-CL")} km</b></div><div class="metric"><small>Ubicación</small><b>${t.location||"—"}</b></div></div>
 <h3>Últimas posiciones</h3>${h.slice(0,10).map(x=>`<p class="note">${new Date(x.recorded_at).toLocaleString("es-CL")} · ${x.lat}, ${x.lng} · ${x.speed_kmh} km/h</p>`).join("")}`;
 document.getElementById("drawer").classList.remove("hidden");
}
async function simulateGPS(){
 const ts=await get("trucks");const t=ts.find(x=>x.status==="En ruta")||ts[0];if(!t)return;
 const lat=Number(t.lat||-36.6)+(Math.random()-.5)*.08,lng=Number(t.lng||-72.1)+(Math.random()-.5)*.08;
 await fetch(`/api/trucks/${t.id}/location`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({lat,lng,location:"GPS simulado",km:Number(t.km||0)+2,speed_kmh:Math.round(55+Math.random()*30),status:"En ruta"})});
 render("dashboard");
}
function table(cols,rows,fn,del){return `<div class="wrap"><table class="table"><thead><tr>${cols.map(c=>`<th>${c}</th>`).join("")}${del?"<th></th>":""}</tr></thead><tbody>${rows.map((x,i)=>`<tr>${fn(x).map(c=>`<td>${c}</td>`).join("")}${del?`<td><button onclick="remove('${del}',${x.id})">Eliminar</button></td>`:""}</tr>`).join("")}</tbody></table></div>`}
async function listing(v,label,cols,fn,endpoint=v){let rows=await get(endpoint);A.innerHTML=`<div class="card"><div class="toolbar"><input class="search" id="q" placeholder="Buscar ${label.toLowerCase()}..."><button class="primary" onclick="openForm('${v}')">+ Nuevo</button></div><div id="tbl">${table(cols,rows,fn,endpoint)}</div></div>`;document.getElementById("q").oninput=e=>{const q=e.target.value.toLowerCase();document.querySelectorAll("tbody tr").forEach(r=>r.style.display=r.textContent.toLowerCase().includes(q)?"":"none")}}
const truck=x=>[x.patente,x.tipo,x.capacidad_t+" t",x.driver||"—",badge(x.status),x.location||"—"];
const driver=x=>[x.name,x.rut,x.license,x.expiry,badge(x.status)];
const route=x=>[x.truck,x.origin,x.destination,x.distance_km+" km",x.progress+"%",badge(x.status)];
const load=x=>[x.client,x.guide,x.cargo,Number(x.weight_kg).toLocaleString("es-CL")+" kg",x.truck,`${x.origin} → ${x.destination}`,badge(x.status)];
const maint=x=>[x.truck,x.item,x.due,money(x.cost_clp),badge(x.status)];
const fuelRow=x=>[x.date,x.truck,x.liters+" L",money(x.price_clp),money(x.total_clp),x.station];
function trucks(){listing("trucks","camiones",["Patente","Tipo","Capacidad","Conductor","Estado","Ubicación"],truck)}
function drivers(){listing("drivers","conductores",["Nombre","RUT","Licencia","Vencimiento","Estado"],driver)}
function routes(){listing("routes","rutas",["Camión","Origen","Destino","Distancia","Avance","Estado"],route)}
function loads(){listing("loads","cargas",["Cliente","Guía","Carga","Peso","Camión","Ruta","Estado"],load)}
function maintenance(){listing("maintenance","mantenciones",["Camión","Servicio","Vencimiento","Costo","Estado"],maint)}
function fuel(){listing("fuel","combustible",["Fecha","Camión","Litros","Precio/L","Total","Estación"],fuelRow)}
async function alerts(){let r=await get("alerts");A.innerHTML=`<div class="card"><h3>Alertas</h3>${r.map(x=>`<div class="alert"><b>${x.title}</b><br>${x.text}</div>`).join("")}</div>`}
async function reports(){let [d,t,l,f]=await Promise.all([get("dashboard"),get("trucks"),get("loads"),get("fuel")]);A.innerHTML=`<div class="grid two"><div class="card"><h3>Indicadores</h3><p>Camiones: <b>${d.trucks}</b></p><p>En ruta: <b>${d.enroute}</b></p><p>Cargas: <b>${d.loads}</b></p><p>Alertas: <b>${d.alerts}</b></p><p>Combustible: <b>${money(d.fuel)}</b></p></div><div class="card"><h3>Utilización</h3>${t.map(x=>`<p>${x.patente} — ${badge(x.status)}</p>`).join("")}</div></div>`}
const forms={trucks:[["patente","Patente"],["tipo","Tipo"],["capacidad_t","Capacidad (t)"],["driver","Conductor"],["location","Ubicación"]],routes:[["truck","Camión"],["origin","Origen"],["destination","Destino"],["distance_km","Distancia km"],["progress","Avance %"]],loads:[["client","Cliente"],["guide","Guía interna"],["cargo","Carga"],["weight_kg","Peso kg"],["volume_m3","Volumen m³"],["value_clp","Valor CLP"],["truck","Camión"],["origin","Origen"],["destination","Destino"]],fuel:[["date","Fecha"],["truck","Camión"],["liters","Litros"],["price_clp","Precio/L"],["station","Estación"]]};
const endpoints={trucks:"trucks",routes:"routes",loads:"loads",fuel:"fuel"};
function openForm(v){let f=forms[v];document.getElementById("mt").textContent="Nuevo "+v;document.getElementById("form").innerHTML=`<div class="formgrid">${f.map(([k,l])=>`<div class="field"><label>${l}</label><input name="${k}" ${["date"].includes(k)?"type=date":""} required></div>`).join("")}<div class="formactions"><button class="primary">Guardar</button></div></div>`;document.getElementById("modal").classList.remove("hidden");document.getElementById("form").onsubmit=async e=>{e.preventDefault();let o=Object.fromEntries(new FormData(e.target));["capacidad_t","distance_km","progress","weight_kg","volume_m3","value_clp","liters","price_clp"].forEach(k=>{if(o[k]!==undefined)o[k]=Number(o[k])});await post(endpoints[v],o);close();render(v)}}
async function remove(t,id){if(confirm("Eliminar registro?")){await fetch(`/api/${t}/${id}`,{method:"DELETE"});render(t==="maintenance"?"maintenance":t)}}
function close(){document.getElementById("modal").classList.add("hidden")}document.getElementById("x").onclick=close;document.getElementById("newBtn").onclick=()=>openForm("routes");
setInterval(()=>{if(document.querySelector(".nav button.active")?.dataset.v==="dashboard") render("dashboard")},15000);
fetch("/api/health").then(r=>r.json()).then(x=>document.getElementById("health").textContent=x.ok?"● Base de datos conectada":"● Error DB").catch(()=>document.getElementById("health").textContent="● Servidor no disponible");render();