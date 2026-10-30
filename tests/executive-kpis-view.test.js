'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const view=require('../public/executive-kpis');
test('notas explican ausencia de viajes/distancia y la base de cumplimiento',()=>{
 assert.match(view.complianceNote({completed:2,denominator:2}),/2\/2 viajes no cancelados/);assert.match(view.complianceNote({denominator:null}),/Sin viajes/);
 assert.equal(view.distanceNote({coverage:{reconciled:{eligible_trips:0,with_distance:0}}},'reconciled'),'Sin viajes conciliados');
 assert.match(view.distanceNote({coverage:{reconciled:{eligible_trips:1,with_distance:0}}},'reconciled'),/Falta distancia/);
});
test('detalle distingue motivo y enlaza solo identificadores válidos sin insertar HTML del cliente',()=>{
 const html=view.missingDetails({delta:{missing_data_trips:1},missing_trips:[{trip_id:2,trip_number:'<img src=x onerror=alert(1)>',status:'Completado',reasons:['revenue_unconfirmed','costs_unrecognized']}]},38);
 assert.match(html,/\?trip=2&amp;company=38/);assert.match(html,/noopener noreferrer/);assert.doesNotMatch(html,/<img/);assert.match(html,/Valor del servicio sin confirmar/);assert.match(html,/Sin costos reconocidos/);
 assert.doesNotMatch(view.missingDetails({delta:{missing_data_trips:1},missing_trips:[{trip_id:'javascript:1',trip_number:'QA'}]},38),/<a /);
 assert.equal(view.missingDetails({delta:{missing_data_trips:0}},38),'');
});
