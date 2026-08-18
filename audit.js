async function writeAudit(db,req,{companyId,action,entity,entityId,beforeData=null,afterData=null}){
  await db.query(
    'insert into audit_logs(company_id,user_id,action,entity,entity_id,before_data,after_data,ip) values($1,$2,$3,$4,$5,$6,$7,$8)',
    [companyId??null,req.user?.id??null,action,entity,entityId===null||entityId===undefined?null:String(entityId),beforeData,afterData,req.ip||null]
  );
}

module.exports={writeAudit};
