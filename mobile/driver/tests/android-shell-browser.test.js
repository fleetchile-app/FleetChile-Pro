'use strict';
// Real Chrome and packaged driver assets, synthetic native bridge/API only.
// This does NOT validate Android WebView, the camera, or device permissions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('packaged driver: login, authenticated API, reload and logout without PWA worker', {
  skip: !process.env.FLEETCHILE_TEST_PLAYWRIGHT, timeout: 120000
}, async () => {
  const { chromium } = require(process.env.FLEETCHILE_TEST_PLAYWRIGHT);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10000);
    const seen = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const user = { id: 8, company_id: 10, driver_id: 4, role_code: 'driver', name: 'Conductor QA' };
    const bridge = fs.readFileSync(path.resolve(__dirname, '../src/native-bridge.js'), 'utf8');
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === 'https://fleetchile-pro.onrender.com') {
        seen.push({ path: url.pathname, method: request.method(), headers: request.headers() });
        const headers = { 'Access-Control-Allow-Origin': 'https://localhost',
          'Access-Control-Allow-Headers': 'authorization,content-type,x-company-context',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        let data = {};
        if (url.pathname === '/api/auth/status') data = { setupRequired: false };
        else if (url.pathname === '/api/auth/login') data = { token: 'synthetic-token', user };
        else if (url.pathname === '/api/auth/me') data = { user };
        else if (url.pathname === '/api/driver/trips') data = [];
        return route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(data) });
      }
      assert.equal(url.origin, 'https://localhost', 'No external requests permitted');
      if (url.pathname === '/native.js') {
        const script = `(function(){const module={exports:{}};${bridge}\nmodule.exports(window,{isNativePlatform:()=>true},{checkPermissions:async()=>({location:'prompt'})});})();`;
        return route.fulfill({ contentType: 'application/javascript', body: script });
      }
      const file = path.resolve(__dirname, '../www', url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(file) });
    });
    await page.goto('https://localhost/');
    await page.locator('input[type=email]').fill('synthetic@example.invalid');
    await page.locator('input[type=password]').fill('SyntheticOnly123!');
    await page.getByRole('button', { name: /Ingresar/ }).click();
    await page.getByText('No tienes viajes asignados.').waitFor().catch(async () => {
      assert.fail(JSON.stringify({ body: await page.locator('body').innerText(), errors, seen }));
    });
    assert.ok(seen.some(row => row.path === '/api/driver/trips' && row.headers.authorization === 'Bearer synthetic-token'));
    await page.reload();
    await page.getByText('No tienes viajes asignados.').waitFor();
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
    await page.locator('.driver-account summary').click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: /Cerrar sesión/ }).click();
    await page.locator('input[type=email]').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('fleet_token')), null);
    assert.ok(seen.some(row => row.path === '/api/auth/logout' && row.method === 'POST'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
