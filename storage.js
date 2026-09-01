const crypto=require('node:crypto');
const {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,DeleteObjectCommand}=require('@aws-sdk/client-s3');

class StorageConfigError extends Error{constructor(message){super(message);this.name='StorageConfigError';}}
class StorageOperationError extends Error{constructor(operation,cause){super(`S3 ${operation} failed`,{cause});this.name='StorageOperationError';this.operation=operation;this.notFound=operation==='head'&&Boolean(cause?.$metadata?.httpStatusCode===404||cause?.name==='NotFound'||cause?.name==='NoSuchKey'||cause?.Code==='NoSuchKey'||cause?.code==='NotFound');}}

function storageConfig(env=process.env){
  const config={region:env.S3_REGION,bucket:env.S3_BUCKET,endpoint:env.S3_ENDPOINT||undefined,accessKeyId:env.S3_ACCESS_KEY_ID,secretAccessKey:env.S3_SECRET_ACCESS_KEY,forcePathStyle:env.S3_FORCE_PATH_STYLE==='true'};
  const missing=['S3_REGION','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'].filter(key=>!env[key]);
  if(missing.length)throw new StorageConfigError(`Storage S3 no configurado: faltan ${missing.join(', ')}`);
  return config;
}

function objectKey({companyId,proofId,type,id=crypto.randomUUID()}){
  if(!Number.isInteger(Number(companyId))||Number(companyId)<1)throw new TypeError('companyId inválido');
  if(!Number.isInteger(Number(proofId))||Number(proofId)<1)throw new TypeError('proofId inválido');
  if(!['signature','photo'].includes(type))throw new TypeError('Tipo de evidencia inválido');
  if(!/^[0-9a-f-]{36}$/i.test(id))throw new TypeError('Identificador de objeto inválido');
  return `companies/${Number(companyId)}/proofs/${Number(proofId)}/${type}/${id}`;
}

function createStorage({env=process.env,client}={}){
  const config=storageConfig(env);
  const s3=client||new S3Client({region:config.region,endpoint:config.endpoint,forcePathStyle:config.forcePathStyle,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey}});
  const put=async({key,body,mimeType,size,metadata={}})=>{if(!key||typeof key!=='string'||key.includes('..')||key.startsWith('/'))throw new TypeError('storage_key inválido');try{await s3.send(new PutObjectCommand({Bucket:config.bucket,Key:key,Body:body,ContentType:mimeType,ContentLength:size,Metadata:metadata}));return {key};}catch(error){throw new StorageOperationError('put',error)}};
  const get=async key=>{if(!key||typeof key!=='string'||key.includes('..')||key.startsWith('/'))throw new TypeError('storage_key inválido');try{return await s3.send(new GetObjectCommand({Bucket:config.bucket,Key:key}));}catch(error){throw new StorageOperationError('get',error)}};
  const head=async key=>{if(!key||typeof key!=='string'||key.includes('..')||key.startsWith('/'))throw new TypeError('storage_key inválido');try{return await s3.send(new HeadObjectCommand({Bucket:config.bucket,Key:key}));}catch(error){throw new StorageOperationError('head',error)}};
  const remove=async key=>{if(!key||typeof key!=='string'||key.includes('..')||key.startsWith('/'))throw new TypeError('storage_key inválido');try{await s3.send(new DeleteObjectCommand({Bucket:config.bucket,Key:key}));return {key};}catch(error){throw new StorageOperationError('delete',error)}};
  return {config,put,get,head,delete:remove};
}

module.exports={createStorage,storageConfig,objectKey,StorageConfigError,StorageOperationError};
