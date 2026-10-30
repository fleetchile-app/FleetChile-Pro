'use strict';
const {resolveActorContext}=require('./auth');
function canResolveOwnRevenue(req,companyId){
 const actor=resolveActorContext(req);
 return !!(actor?.actor_type==='company'&&actor.scope==='company'&&actor.membership_id&&
  String(actor.company_id)===String(companyId)&&['company_admin','manager'].includes(actor.role)&&actor.permissions?.includes('economics.approve'));
}
module.exports={canResolveOwnRevenue};
