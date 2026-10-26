'use strict';

const {companyDate}=require('./personnel-domain');

const REASONS={
 DRIVER_NOT_FOUND:'El conductor no existe en la empresa',
 OPERATIONAL_REGISTRATION_MISSING:'El conductor no está registrado operacionalmente',
 DRIVER_INACTIVE:'El conductor no está activo',
 ACCOUNT_MISSING:'El conductor no tiene usuario asociado',
 ACCOUNT_DISABLED:'La cuenta del conductor está desactivada',
 MEMBERSHIP_MISSING:'El usuario no tiene membresía en la empresa',
 MEMBERSHIP_INACTIVE:'La membresía del conductor está inactiva',
 DRIVER_ROLE_REQUIRED:'La membresía no tiene rol conductor',
 PERSON_MISSING:'El conductor no tiene persona canónica regularizada',
 CONTRACT_MISSING_OR_EXPIRED:'El contrato del conductor no está vigente',
 CONDITION_ACTIVE:'El conductor tiene una condición activa',
 LICENSE_MISSING_OR_EXPIRED:'La licencia canónica no está vigente'
};

function readinessError(reasons){
 const error=new Error(reasons.map(reason=>REASONS[reason]||reason).join('; '));
 error.status=409;error.code='DRIVER_NOT_OPERATIONAL_READY';error.reasons=reasons;
 return error;
}
async function assertDriverOperationalReady(db,{companyId,driverId,now=new Date(),lock=false}={}){
 if(!db||typeof db.query!=='function')throw new TypeError('db.query es obligatorio');
 if(!companyId||!driverId)throw readinessError(['DRIVER_NOT_FOUND']);
 const id=Number(driverId),cid=Number(companyId);
 if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(cid)||cid<1)throw readinessError(['DRIVER_NOT_FOUND']);
 const lockClause=lock?' for update':'';
 const policy=(await db.query('select time_zone from company_personnel_policies where company_id=$1',[cid])).rows[0]||{};
 // This order is intentional and matches personnel account mutations:
 // membership -> canonical person -> driver.
 const membership=(await db.query(`select um.id membership_id,um.user_id,um.active membership_active,u.active account_active,r.code role_code
  from user_memberships um join users u on u.id=um.user_id join roles r on r.id=um.role_id
  where um.company_id=$1 and u.company_id=$1 and u.driver_id=$2${lock?' for update of um':''}`,[cid,id])).rows[0]||null;
 const person=membership?(await db.query(`select p.id,p.driver_id,p.user_id from company_people p
  where p.company_id=$1 and p.user_id=$2${lockClause}`,[cid,membership.user_id])).rows[0]||null:null;
 const driver=(await db.query(`select id,company_id,status,operational_registered_at,profile_version from drivers
  where company_id=$1 and id=$2${lockClause}`,[cid,id])).rows[0]||null;
 const reasons=[];
 if(!driver)reasons.push('DRIVER_NOT_FOUND');
 else{
  if(!driver.operational_registered_at)reasons.push('OPERATIONAL_REGISTRATION_MISSING');
  if(driver.status!=='Activo')reasons.push('DRIVER_INACTIVE');
 }
 if(!membership)reasons.push('ACCOUNT_MISSING','MEMBERSHIP_MISSING');
 else{
  if(membership.account_active!==true)reasons.push('ACCOUNT_DISABLED');
  if(membership.membership_active!==true)reasons.push('MEMBERSHIP_INACTIVE');
  if(membership.role_code!=='driver')reasons.push('DRIVER_ROLE_REQUIRED');
 }
 if(!person||person.driver_id!==id)reasons.push('PERSON_MISSING');
 const today=companyDate(now,policy.time_zone);
 if(person){
  const contract=(await db.query(`select 1 from person_contracts where company_id=$1 and person_id=$2 and voided_at is null
   and start_date<=$3::date and (end_date is null or end_date>=$3::date) limit 1`,[cid,person.id,today])).rowCount>0;
  const condition=(await db.query(`select 1 from person_conditions where company_id=$1 and person_id=$2 and cancelled_at is null
   and start_date<=$3::date and end_date>=$3::date limit 1`,[cid,person.id,today])).rowCount>0;
  const license=(await db.query(`select effective_expiry::text from person_driver_licenses where company_id=$1 and person_id=$2 and current=true order by id desc limit 1`,[cid,person.id])).rows[0];
  if(!contract)reasons.push('CONTRACT_MISSING_OR_EXPIRED');
  if(condition)reasons.push('CONDITION_ACTIVE');
  const expiry=license?.effective_expiry instanceof Date?license.effective_expiry.toISOString().slice(0,10):String(license?.effective_expiry||'');
  if(!license?.effective_expiry||!/^\d{4}-\d{2}-\d{2}$/.test(expiry)||expiry<today)reasons.push('LICENSE_MISSING_OR_EXPIRED');
 }
 if(reasons.length)throw readinessError([...new Set(reasons)]);
 return {ready:true,companyId:cid,driverId:id,userId:membership.user_id,membershipId:membership.membership_id,personId:person.id,profileVersion:driver.profile_version};
}

module.exports={assertDriverOperationalReady,readinessError,REASONS};
