'use strict';
function databaseSsl(env=process.env){
 if(env.DATABASE_SSL!=='true')return undefined;
 const ssl={rejectUnauthorized:env.DATABASE_SSL_VERIFY==='true'};
 if(env.DATABASE_SSL_CA_BASE64){const ca=Buffer.from(env.DATABASE_SSL_CA_BASE64,'base64').toString('utf8');if(!ca.includes('-----BEGIN CERTIFICATE-----'))throw Error('Certificado CA de PostgreSQL no válido');ssl.ca=ca;}
 return ssl;
}
module.exports={databaseSsl};
