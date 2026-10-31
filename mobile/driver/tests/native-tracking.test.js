'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const install = require('../src/native-bridge');
function fixture(available = true, native = true) {
  const calls=[];
  const win={location:{origin:'https://localhost',href:'https://localhost/'},navigator:{},fetch:async()=>{}};
  const plugin={start:async o=>{calls.push(['start',o]);return {running:true};},stop:async()=>calls.push(['stop']),status:async()=>({running:true,pending:3})};
  install(win,{isNativePlatform:()=>native,isPluginAvailable:name=>available && name==='FleetTracking'},{},plugin);
  return {win,calls};
}
test('background capability requires registered native plugin',()=>{
  assert.equal(fixture(false).win.FleetNative.backgroundGps,false);
  assert.equal(fixture(false).win.FleetTracking,undefined);
  assert.equal(fixture(true,false).win.FleetTracking,undefined);
  assert.equal(fixture().win.FleetNative.backgroundGps,true);
});
test('tracking delegates only trip and token; JS never receives native queue credentials',async()=>{
  const {win,calls}=fixture();
  await win.FleetTracking.start({tripId:123,token:'synthetic',url:'https://evil.test',companyId:99});
  assert.deepEqual(calls,[['start',{tripId:'123',token:'synthetic'}]]);
  assert.deepEqual(await win.FleetTracking.status(),{running:true,pending:3});
  await win.FleetTracking.stop();
  assert.deepEqual(calls[1],['stop']);
  assert.ok(Object.isFrozen(win.FleetTracking));
});
