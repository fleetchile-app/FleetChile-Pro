'use strict';
// Read-only: no SDK download, Gradle execution, application startup or DB access.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function inspect(env = process.env) {
  const failures = [];
  const sdk = env.ANDROID_HOME;
  if (!sdk || !fs.existsSync(path.join(sdk, 'platforms/android-36/android.jar'))) {
    failures.push('Instala Android SDK Platform 36 y apunta ANDROID_HOME a su SDK.');
  }
  if (!sdk || !fs.existsSync(path.join(sdk, 'build-tools/36.0.0'))) {
    failures.push('Instala Android SDK Build-Tools 36.0.0.');
  }
  if (!env.GRADLE_USER_HOME) failures.push('Define GRADLE_USER_HOME en D para evitar nuevas caches en C.');
  const java = env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const result = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 10000, env });
  const output = String(result.stderr || '') + String(result.stdout || '');
  const major = Number(output.match(/version "(\d+)/)?.[1]);
  if (result.status !== 0 || major !== 21) {
    failures.push('Selecciona un JDK 21 para JAVA_HOME y Gradle JDK; el JDK del IDE puede ser distinto.');
  }
  return { ok: failures.length === 0, failures, javaMajor: major || null, sdk: sdk || null,
    scope: 'Configuracion local solamente; no prueba APK, telefono, servidor ni GPS.' };
}
if (require.main === module) {
  const result = inspect();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
module.exports = { inspect };
