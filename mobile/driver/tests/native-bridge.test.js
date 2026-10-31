'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const install = require('../src/native-bridge');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ native = true, geo = {} } = {}) {
  const calls = [], cleared = [];
  const win = {
    location: { origin: 'https://localhost', href: 'https://localhost/index.html' },
    navigator: { permissions: { query: async () => ({ state: 'denied' }) } },
    fetch: async (input, options) => {
      calls.push({ input, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  };
  const provider = {
    checkPermissions: async () => ({ location: 'granted' }),
    requestPermissions: async () => ({ location: 'granted' }),
    getCurrentPosition: async () => ({ timestamp: 123, coords: { latitude: -36, longitude: -73 } }),
    watchPosition: async () => 'native-watch',
    clearWatch: async ({ id }) => { cleared.push(id); }, ...geo
  };
  const original = win.fetch;
  install(win, { isNativePlatform: () => native }, provider);
  return { win, calls, cleared, original };
}

test('web browser is not modified', () => {
  const f = fixture({ native: false });
  assert.equal(f.win.fetch, f.original);
  assert.equal(f.win.navigator.geolocation, undefined);
});

test('only local API requests are mapped to the fixed HTTPS server', async () => {
  const { win, calls } = fixture();
  const abort = new AbortController();
  await win.fetch('/api/driver/trips?limit=2', { method: 'POST', body: '{}', signal: abort.signal });
  assert.equal(calls[0].input, 'https://fleetchile-pro.onrender.com/api/driver/trips?limit=2');
  assert.equal(calls[0].options.signal, abort.signal);
  assert.equal(calls[0].options.body, '{}');
  await win.fetch('/driver.css');
  assert.equal(calls[1].input, '/driver.css');
});

test('external hosts cannot receive credentials through the bridge', async () => {
  const { win, calls } = fixture();
  for (const url of ['https://evil.example/api/x', '//evil.example/api/x',
    'http://localhost/api/x', 'https://fleetchile-pro.onrender.com/api/x']) {
    await assert.rejects(win.fetch(url, { headers: { Authorization: 'Bearer test' } }), /no permitido/);
  }
  assert.equal(calls.length, 0);
});

test('Request body, headers and method are preserved', async () => {
  const { win, calls } = fixture();
  await win.fetch(new Request('https://localhost/api/driver/x', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: '{"x":1}'
  }));
  const forwarded = calls[0].input;
  assert.equal(forwarded.url, 'https://fleetchile-pro.onrender.com/api/driver/x');
  assert.equal(forwarded.headers.get('Authorization'), 'Bearer test');
  assert.equal(await forwarded.text(), '{"x":1}');
});

test('existing Auth wrapper adds Bearer and company before forwarding', async () => {
  const { win, calls } = fixture();
  const values = new Map([['fleet_token', 'test-token'], ['fleet_company_context', '38']]);
  const context = { window: win, localStorage: { getItem: key => values.get(key) || null },
    document: { addEventListener() {} }, URL, Headers, console };
  win.addEventListener = () => {};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../public/auth.js'), 'utf8'), context);
  context.fetch = win.fetch;
  await win.Auth.request('/api/driver/trips');
  assert.equal(calls[0].input, 'https://fleetchile-pro.onrender.com/api/driver/trips');
  assert.equal(calls[0].options.headers.get('Authorization'), 'Bearer test-token');
  assert.equal(calls[0].options.headers.get('X-Company-Context'), '38');
});

test('native permission is requested on location use, not app startup', async () => {
  let requested = 0;
  const { win } = fixture({ geo: {
    checkPermissions: async () => ({ location: 'prompt' }),
    requestPermissions: async () => { requested++; return { location: 'granted' }; }
  }});
  assert.equal(requested, 0);
  const position = await new Promise((resolve, reject) => win.navigator.geolocation.getCurrentPosition(resolve, reject));
  assert.equal(position.coords.latitude, -36);
  assert.equal(requested, 1);
  assert.equal(win.FleetNative.backgroundGps, false);
});

test('denied native permission returns geolocation error without collecting positions', async () => {
  let observed = false;
  const { win } = fixture({ geo: {
    checkPermissions: async () => ({ location: 'denied' }),
    requestPermissions: async () => ({ location: 'denied' }),
    getCurrentPosition: async () => { observed = true; }
  }});
  const error = await new Promise(resolve => win.navigator.geolocation.getCurrentPosition(() => assert.fail(), resolve));
  assert.equal(error.code, 1);
  assert.equal(observed, false);
});

test('clearing while native watch starts suppresses late callbacks and clears native watch', async () => {
  let resolveWatch, deliver, count = 0;
  const { win, cleared } = fixture({ geo: {
    watchPosition: (options, callback) => { deliver = callback; return new Promise(resolve => { resolveWatch = resolve; }); }
  }});
  const key = win.navigator.geolocation.watchPosition(() => count++);
  await flush();
  win.navigator.geolocation.clearWatch(key);
  deliver({ coords: {} });
  resolveWatch('late-watch');
  await flush();
  assert.equal(count, 0);
  assert.deepEqual(cleared, ['late-watch']);
});

test('native permissions replace irrelevant browser state', async () => {
  const { win } = fixture();
  assert.equal((await win.navigator.permissions.query({ name: 'geolocation' })).state, 'granted');
  assert.equal((await win.navigator.permissions.query({ name: 'camera' })).state, 'denied');
});

test('package uses local assets, HTTPS, and no background location permission', () => {
  const root = path.resolve(__dirname, '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json')));
  assert.equal(config.server.url, undefined);
  assert.equal(config.server.cleartext, false);
  assert.equal(config.plugins.CapacitorHttp.enabled, true);
  const { assets } = require('../scripts/build');
  assert.ok(!assets.includes('app.js'));
  assert.ok(!assets.includes('server.js'));
  const output = path.join(root, 'www');
  assert.deepEqual(fs.readdirSync(output).sort(), [...assets, 'index.html', 'native.js'].sort());
  const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
  assert.ok(html.indexOf('/native.js') < html.indexOf('/auth.js'));
  assert.doesNotMatch(html, /manifest.webmanifest|\/app.js/);
  assert.doesNotMatch(fs.readFileSync(path.join(output, 'driver.js'), 'utf8'), /serviceWorker\.register/);
  const manifestPath = path.join(root, 'android/app/src/main/AndroidManifest.xml');
  if (fs.existsSync(manifestPath)) {
    const manifest = fs.readFileSync(manifestPath, 'utf8');
    assert.match(manifest, /ACCESS_FINE_LOCATION/);
    assert.doesNotMatch(manifest, /ACCESS_BACKGROUND_LOCATION/);
    assert.match(manifest, /android:allowBackup="false"/);
  }
});
