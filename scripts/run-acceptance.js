'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path');
function prepare(env=process.env,{native=false,extended=false}={}){
 if(native){require('../tests/helpers/native-postgres').configuration(env);return ['tests/acceptance-native.pg.js'];}
 if(!env.FLEETCHILE_TEST_PGLITE)throw Error('Configura FLEETCHILE_TEST_PGLITE con el runtime aislado; no se ejecutará una aceptación omitida.');
 try{require.resolve(env.FLEETCHILE_TEST_PGLITE)}catch{throw Error('El runtime aislado indicado en FLEETCHILE_TEST_PGLITE no está disponible.');}
 if(extended){
  if(!env.FLEETCHILE_TEST_PLAYWRIGHT)throw Error('El cierre ampliado requiere FLEETCHILE_TEST_PLAYWRIGHT; no se omitirán las pruebas de navegador.');
  try{require.resolve(env.FLEETCHILE_TEST_PLAYWRIGHT)}catch{throw Error('El runtime de navegador no está disponible.');}
  return ['tests/acceptance-integrated.test.js','tests/acceptance-access-scale.test.js','tests/acceptance-safety.test.js',
   'tests/pod-evidence.test.js','tests/pod-evidence-browser.test.js','tests/driver-recovery-browser.test.js',
   'tests/itinerary-postgres.integration.test.js','tests/equipment-postgres.integration.test.js',
   'tests/finance-postgres.integration.test.js','tests/commercial-postgres.integration.test.js',
   'tests/enterprise-postgres.integration.test.js','tests/company-branding-postgres.integration.test.js',
   'tests/driver-pdf.test.js','tests/platform-ownership.test.js','tests/bootstrap-owner.test.js'];
 }
 return ['tests/acceptance-integrated.test.js','tests/acceptance-safety.test.js'];
}
if(require.main===module){try{const files=prepare(process.env,{native:process.argv.includes('--postgres'),extended:process.argv.includes('--extended')}),r=spawnSync(process.execPath,['--test','--test-concurrency=2',...files],{cwd:path.join(__dirname,'..'),stdio:'inherit',env:process.env});process.exitCode=r.status??1;}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={prepare};
