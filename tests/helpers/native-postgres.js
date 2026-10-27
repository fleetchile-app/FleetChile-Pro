'use strict';
const crypto=require('node:crypto'),{Pool}=require('pg');
const {initialize}=require('./acceptance');
function configuration(env=process.env){
 if(env.FLEETCHILE_TEST_PG_CREATE!=='disposable-local-database')throw Error('Falta confirmación de base local desechable: FLEETCHILE_TEST_PG_CREATE');
 let url;try{url=new URL(env.FLEETCHILE_TEST_PG_URL)}catch{throw Error('Falta FLEETCHILE_TEST_PG_URL válido; nunca se usa DATABASE_URL');}
 const local=host=>['localhost','127.0.0.1','[::1]'].includes(host);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!local(url.hostname)||!['/postgres','/template1'].includes(url.pathname)||url.search||url.hash)throw Error('Las pruebas exigen PostgreSQL local, sin parámetros que alteren la conexión y base administrativa postgres/template1');
 if(env.DATABASE_URL){let production;try{production=new URL(env.DATABASE_URL)}catch{}if(production&&local(production.hostname)&&(production.port||'5432')===(url.port||'5432'))throw Error('El servidor de pruebas no puede coincidir con DATABASE_URL');}
 return {url,name:'fleetchile_accept_'+crypto.randomBytes(12).toString('hex')};
}
async function nativePostgres({env=process.env}={}){
 const cfg=configuration(env),admin=new Pool({connectionString:cfg.url.href,max:1,connectionTimeoutMillis:5000,statement_timeout:30000});let pool,created=false,closed=false;
 const close=async()=>{
  if(closed)return;closed=true;await pool?.end();
  try{if(created){if(!/^fleetchile_accept_[a-f0-9]{24}$/.test(cfg.name))throw Error('Se rechazó una limpieza fuera de alcance');await admin.query('DROP DATABASE "'+cfg.name+'"');}}
  finally{await admin.end();}
 };
 try{
  await admin.query('CREATE DATABASE "'+cfg.name+'" TEMPLATE template0');created=true;
  const url=new URL(cfg.url);url.pathname='/'+cfg.name;pool=new Pool({connectionString:url.href,max:8,connectionTimeoutMillis:5000,statement_timeout:15000,lock_timeout:7000});
  const client=await pool.connect();try{await initialize(sql=>client.query(sql));}finally{client.release();}
  return {pool,name:cfg.name,close};
 }catch(e){try{await close()}catch{}throw Object.assign(Error('No se pudo preparar PostgreSQL local aislado; no se utilizó la base de la aplicación'),{cause:e});}
}
module.exports={configuration,nativePostgres};
