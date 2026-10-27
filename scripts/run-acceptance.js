'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path');
function prepare(env=process.env,{native=false}={}){
 if(native){require('../tests/helpers/native-postgres').configuration(env);return ['tests/acceptance-native.pg.js'];}
 if(!env.FLEETCHILE_TEST_PGLITE)throw Error('Configura FLEETCHILE_TEST_PGLITE con el runtime aislado; no se ejecutará una aceptación omitida.');
 try{require.resolve(env.FLEETCHILE_TEST_PGLITE)}catch{throw Error('El runtime aislado indicado en FLEETCHILE_TEST_PGLITE no está disponible.');}
 return ['tests/acceptance-integrated.test.js','tests/acceptance-safety.test.js'];
}
if(require.main===module){try{const files=prepare(process.env,{native:process.argv.includes('--postgres')}),r=spawnSync(process.execPath,['--test',...files],{cwd:path.join(__dirname,'..'),stdio:'inherit',env:process.env});process.exitCode=r.status??1;}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={prepare};
