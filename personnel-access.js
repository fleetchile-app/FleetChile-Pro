'use strict';
const {companyDate,evaluateEligibility}=require('./personnel-domain');

// Snapshot is always server-derived. The same evaluator is used by authentication,
// transaction guards and the notification worker; notifications never grant access.
function evaluateSnapshot(snapshot,now){
 if(!snapshot?.policy||typeof snapshot.policy.enforced!=='boolean'||typeof snapshot.policy.time_zone!=='string'||!snapshot.policy.time_zone)throw new Error('Política de personas no disponible');
 const today=companyDate(now||new Date(),snapshot.policy.time_zone);
 const regularizing=!snapshot.person&&snapshot.policy.enforced===false&&snapshot.regularization_eligible===true;
 const result=evaluateEligibility({...snapshot,role_code:snapshot.membership?.role_code,
  membership_active:snapshot.membership?.active===true,today});
 const allowed=regularizing&&snapshot.account_active===true&&snapshot.membership?.active===true?true:result.allowed;
 return {...result,allowed,code:allowed?null:result.code,reasons:allowed?[]:result.reasons,
  enforced:!regularizing,person_id:snapshot.person?.id||null,today,regularization_required:regularizing};
}

async function loadEligibility(db,{companyId,userId,personId,now,lock=false,snapshot}={}){
 if(!companyId||(!userId&&!personId))throw new Error('Contexto de persona obligatorio');
 if(lock){
  // Membership then person matches account mutations. Do not lock the whole
  // company: a POD upload must not serialize GPS from unrelated drivers.
  await db.query(`select m.id from user_memberships m where m.company_id=$1
   and ($2::bigint is not null and m.user_id=$2 or $3::bigint is not null and m.id=(select membership_id from company_people where company_id=$1 and id=$3)) for update`,[companyId,userId||null,personId||null]);
  await db.query(`select id from company_people where company_id=$1 and
   ($2::bigint is not null and user_id=$2 or $3::bigint is not null and id=$3) for update`,[companyId,userId||null,personId||null]);
  snapshot=undefined;
 }
 if(!snapshot){
  const {rows}=await db.query(`select jsonb_build_object(
   'policy',jsonb_build_object('enforced',pp.enforced,'time_zone',pp.time_zone),
   'regularization_eligible',m.created_at<=pp.regularization_before and u.created_at<=pp.regularization_before,
   'person',to_jsonb(p),
   'membership',case when m.id is null then null else jsonb_build_object('active',m.active,'role_code',r.code) end,
   'account_active',coalesce(u.active,false),
   'contracts',coalesce((select jsonb_agg(c) from person_contracts c where c.company_id=pp.company_id and c.person_id=p.id),'[]'::jsonb),
   'conditions',coalesce((select jsonb_agg(c) from person_conditions c where c.company_id=pp.company_id and c.person_id=p.id),'[]'::jsonb),
   'licenses',coalesce((select jsonb_agg(l) from person_driver_licenses l where l.company_id=pp.company_id and l.person_id=p.id and l.current),'[]'::jsonb)
  ) as personnel_state from company_personnel_policies pp
  left join company_people p on p.company_id=pp.company_id and ($2::bigint is not null and p.user_id=$2 or $3::bigint is not null and p.id=$3)
  left join user_memberships m on m.company_id=pp.company_id and m.user_id=coalesce(p.user_id,$2::bigint)
  left join users u on u.id=m.user_id left join roles r on r.id=m.role_id
  where pp.company_id=$1`,[companyId,userId||null,personId||null]);
  snapshot=rows[0]?.personnel_state;
 }
 return evaluateSnapshot(snapshot,now);
}

async function enforcePersonnelAccess(db,req,{lock=false,snapshot=req.user?.personnel_state}={}){
 const user=req.user;
 // Governance actors are not employees merely because they select a support context.
 if(user?.actor_type==='platform'||user?.scope!=='company')return {allowed:true,enforced:false,reasons:[]};
 return loadEligibility(db,{companyId:user.company_id,userId:user.id,lock,snapshot});
}
module.exports={loadEligibility,enforcePersonnelAccess,evaluateSnapshot};
