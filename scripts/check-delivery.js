'use strict';
// Static validation only. Never opens a database or launches the application.
const fs=require('node:fs'),path=require('node:path');
const {databaseSsl}=require('../deployment-config'),{limits}=require('../portability-package'),{settings}=require('../service-operations'),{storageConfig}=require('../storage');
function check({root=path.join(__dirname,'..'),env=process.env,config=false}={}){
 const files=['migrations/041_delivery_operations.sql','deploy/compose.private.yml','docs/ENTREGA_OPERACIONAL.md','docs/MANUALES_POR_ROL.md','docs/INSTALACION_PRIVADA.md','docs/ACEPTACION_CIERRE.md'];
 const failures=files.filter(f=>!fs.existsSync(path.join(root,f))).map(f=>'Falta '+f);
 const startup=fs.readFileSync(path.join(root,'startup.js'),'utf8');if(!startup.includes("'041_delivery_operations.sql'"))failures.push('Migración 041 no registrada');
 if(config){for(const [name,fn] of [['DATABASE_SSL',()=>databaseSsl(env)],['EXPORT_LIMITS',()=>limits(env)],['MONITOR_TECHNICAL_DAYS',()=>settings(env)],['S3_REQUIRED_FIELDS',()=>storageConfig(env)]])try{fn()}catch{failures.push('Configuración no válida: '+name)}if(!env.DATABASE_URL)failures.push('Falta DATABASE_URL');if(env.NODE_ENV==='production'&&(env.DATABASE_SSL!=='true'||env.DATABASE_SSL_VERIFY!=='true'))failures.push('Producción requiere PostgreSQL TLS verificado para cerrar aceptación');}
 return {ok:failures.length===0,failures,scope:'Validación estática; no demuestra conectividad, instalación, restauración ni despliegue.'};
}
if(require.main===module){const result=check({config:process.argv.includes('--config')});console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;}
module.exports={check};
