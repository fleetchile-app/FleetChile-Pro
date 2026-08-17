const A=document.getElementById("app"),nav=document.getElementById("nav"),title=document.getElementById("title");let map;
const menus=[
 ["dashboard","⌂","Inicio","OPERACIÓN"],
 ["trucks","🚛","Camiones","FLOTA"],["drivers","👤","Conductores","FLOTA"],["maintenance","🔧","Mantenciones","FLOTA"],["fuel","⛽","Combustible","FLOTA"],["documents","▤","Documentos","FLOTA"],
 ["clients","🏢","Clientes","OPERACIONES"],["routes","↗","Rutas","OPERACIONES"],["trips","◈","Viajes","OPERACIONES"],["loads","▣","Cargas","OPERACIONES"],
 ["alerts","⚠","Alertas","CONTROL"],["reports","▥","Reportes","CONTROL"]
];
function buildNav(){let groups=[];for(const m of menus){let g=groups.find(x=>x.name===m[3]);if(!g){g={name:m[3],items:[]};groups.push(g)}g.items.push(m)}nav.innerHTML=groups.map(g=>`<div class="nav-group"><div class="nav-section">${g.name}</div>${g.items.map(x=>`<button data-v="${x[0]}" title="${x[2]}"><i>${x[1]}</i><span>${x[2]}</span></button>`).join("")}</div>`).join("");nav.querySelectorAll("button").forEach(b=>b.onclick=()=>render(b.dataset.v))}
buildNav();
const get=async u=>{const r=await fetch("/api/"+u);const d=await r.json();if(!r.ok)throw Error(d.error||"Error de servidor");return d};
const post=async(u,o)=>{const r=await fetch("/api/"+u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});const d=await r.json();if(!r.ok)throw Error(d.error||"No se pudo guardar");return d};
const money=n=>new Intl.NumberFormat("es-CL",{style:"currency",currency:"CLP",maximumFractionDigits:0}).format(n||0);
const badge=s=>`<span class="badge ${/Pendiente|Borrador|Planificada|Mantención|Planificado/.test(s)?"amber":/atras|error|crítico|Cancelado/i.test(s)?"red":""}">${s||""}</span>`;
function render(v="dashboard"){nav.querySelectorAll("button").forEach(b=>b.classList.toggle("active",b.dataset.v===v));title.textContent=menus.find(x=>x[0]===v)?.[2]||"FleetChile";Promise.resolve(window[v]()).catch(e=>{A.innerHTML=`<div class="card"><h3>No se pudo cargar</h3><p>${e.message}</p></div>`})}