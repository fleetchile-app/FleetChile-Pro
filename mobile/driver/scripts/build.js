'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.resolve(root, '../../public');
const assets = ['auth.js', 'driver-vault.js', 'checklist-shared.js', 'driver-mobile.js', 'driver-fuel.js', 'driver-outing.js',
  'company-branding.js', 'driver.js', 'driver.css', 'company-branding.css', 'checklist.css'];

function prepareHtml(html) {
  const driverScript = '<script src="/driver.js"></script>';
  const outingScript = '<script src="/driver-outing.js"></script>';
  if (!html.includes(driverScript)) throw new Error('Revisar script driver.js antes de empaquetar');
  if (!html.includes(outingScript)) html = html.replace(driverScript, outingScript + driverScript);
  if (html.indexOf(outingScript) > html.indexOf(driverScript)) {
    throw new Error('driver-outing.js debe cargarse antes de driver.js');
  }
  return html.replace('<link rel="manifest" href="/manifest.webmanifest">', '')
    .replace('<script src="/auth.js">', '<script src="/native.js"></script><script src="/auth.js">');
}

async function build() {
  const destination = path.join(root, 'www');
  fs.mkdirSync(destination, { recursive: true });
  const allowed = new Set([...assets, 'index.html', 'native.js']);
  for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
    if (!entry.isFile() || !allowed.has(entry.name)) {
      throw new Error('Archivo no autorizado en www: ' + entry.name);
    }
  }
  // Explicit allowlist: never package the administrative SPA, server or secrets.
  for (const name of assets) fs.copyFileSync(path.join(source, name), path.join(destination, name));
  const html = prepareHtml(fs.readFileSync(path.join(source, 'driver.html'), 'utf8'));
  fs.writeFileSync(path.join(destination, 'index.html'), html);
  // Packaged assets replace the PWA shell cache; an Android WebView is not the PWA.
  const driverPath = path.join(destination, 'driver.js');
  const driver = fs.readFileSync(driverPath, 'utf8');
  const registration = "if('serviceWorker' in navigator)navigator.serviceWorker.register('/service-worker.js',{scope:'/driver'});";
  if (!driver.includes(registration)) throw new Error('Revisar registro de service worker antes de empaquetar');
  fs.writeFileSync(driverPath, driver.replace(registration, '/* Native assets are bundled in the APK. */'));
  await require('esbuild').build({ entryPoints: [path.join(root, 'src/native.js')],
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022',
    outfile: path.join(destination, 'native.js') });
  console.log('Interfaz del conductor preparada; sin conectar a Render ni a la base de datos.');
}
if (require.main === module) build().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { build, assets, prepareHtml };
