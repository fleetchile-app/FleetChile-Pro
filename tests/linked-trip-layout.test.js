const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('vista de viaje elimina la altura de pantalla que desplazaba la ficha fuera de la vista inicial',()=>{
 const base=fs.readFileSync(require.resolve('../public/styles.css'),'utf8');
 const gps=fs.readFileSync(require.resolve('../public/gps.css'),'utf8');
 assert.match(base,/main\{[^}]*min-height:100vh/);
 const linked=gps.match(/\.linked-trip-view main\{([^}]*)\}/)?.[1];
 assert.ok(linked);assert.match(linked,/min-height:0(?:;|$)/);assert.match(linked,/padding-bottom:0(?:;|$)/);
 assert.match(gps,/\.linked-trip-view #drawer\{position:static/);
});

test('conductor cliente y viaje se presentan antes de las métricas y el historial GPS',()=>{
 const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8');
 const markup=source.split(/\r?\n/).find(line=>line.startsWith(' document.getElementById("drawerBody").innerHTML='));
 assert.ok(markup);
 assert.ok(markup.indexOf('id="truckGpsTrip"')<markup.indexOf('class="metric-grid"'));
 assert.ok(markup.indexOf('id="truckGpsTrip"')<markup.indexOf('Historial GPS'));
 assert.equal((markup.match(/id="truckGpsTrip"/g)||[]).length,1);
});
