const A=document.getElementById("app"),nav=document.getElementById("nav"),title=document.getElementById("title");let map;
const icons={
 dashboard:`<svg viewBox="0 0 24 24"><path d="M3 12 12 3l9 9"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg>`,
 trucks:`<svg viewBox="0 0 24 24"><path d="M3 6h11v11H3z"/><path d="M14 10h4l3 3v4h-7z"/><path d="M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/></svg>`,
 drivers:`<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>`,
 routes:`<svg viewBox="0 0 24 24"><path d="M5 19c5 0 5-14 14-14"/><path d="m15 3 4 2-4 2"/><circle cx="5" cy="19" r="2"/></svg>`,
 trips:`<svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 17c5-1 5-8 8-9"/></svg>`,
 loads:`<svg viewBox="0 0 24 24"><path d="M4 7h16v13H4z"/><path d="M8 7V5h8v2M8 11h8"/></svg>`,
 maintenance:`<svg viewBox="0 0 24 24"><path d="m14 6 4-3 3 3-3 4"/><path d="m13 7-9 9 4 4 9-9"/></svg>`,
 fuel:`<svg viewBox="0 0 24 24"><path d="M5 20V5h9v15M5 9h9M16 7h3l2 3v7a2 2 0 0 0 2 2"/><path d="M8 5V3h5v2"/></svg>`,
 documents:`<svg viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z"/><path d="M15 3v4h4M9 12h6M9 16h6"/></svg>`,
 clients:`<svg viewBox="0 0 24 24"><path d="M4 21V6h16v15"/><path d="M8 6V3h8v3M8 10h2M14 10h2M8 14h2M14 14h2"/></svg>`,
 alerts:`<svg viewBox="0 0 24 24"><path d="M12 4 21 20H3z"/><path d="M12 9v5M12 17h.01"/></svg>`,
 reports:`<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`
};
const menus=[
 ["dashboard",icons.dashboard,"Dashboard","OPERACIÓN"],
 ["trucks",icons.trucks,"Camiones","FLOTA"],["drivers",icons.drivers,"Conductores","FLOTA"],["routes",icons.routes,"Rutas","OPERACIONES"],["trips",icons.trips,"Viajes","OPERACIONES"],["loads",icons.loads,"Cargas","OPERACIONES"],
 ["documents",icons.documents,"Documentos SII","CONTROL"],["maintenance",icons.maintenance,"Mantenciones","FLOTA"],["fuel",icons.fuel,"Combustible","FLOTA"],["alerts",icons.alerts,"Incidentes","CONTROL"],["reports",icons.reports,"Reportes","CONTROL"]
];
function buildNav(){let groups=[];for(const m of menus){let g=groups.find(x=>x.name===m[3]);if(!g){g={name:m[3],items:[]};groups.push(g)}g.items.push(m)}nav.innerHTML=groups.map(g=>`<div class="nav-group"><div class="nav-section">${g.name}</div>${g.items.map(x=>`<button data-v="${x[0]}" title="${x[2]}"><i>${x[1]}</i><span>${x[2]}</span></button>`).join("")}</div>`).join("");nav.querySelectorAll("button").forEach(b=>b.onclick=()=>render(b.dataset.v))}
buildNav();
const get=async u=>{const r=await fetch("/api/"+u);const d=await r.json();if(!r.ok)throw Error(d.error||"Error de servidor");return d};
const post=async(u,o)=>{const r=await fetch("/api/"+u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});const d=await r.json();if(!r.ok)throw Error(d.error||"No se pudo guardar");return d};
const money=n=>new Intl.NumberFormat("es-CL",{style:"currency",currency:"CLP",maximumFractionDigits:0}).format(n||0);
const badge=s=>`<span class="badge ${/Pendiente|Borrador|Planificada|Mantención|Planificado/.test(s)?"amber":/atras|error|crítico|Cancelado/i.test(s)?"red":""}">${s||""}</span>`;
function render(v="dashboard"){nav.querySelectorAll("button").forEach(b=>b.classList.toggle("active",b.dataset.v===v));title.textContent=menus.find(x=>x[0]===v)?.[2]||"FleetChile";Promise.resolve(window[v]()).catch(e=>{A.innerHTML=`<div class="card"><h3>No se pudo cargar</h3><p>${e.message}</p></div>`})}