'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {canResolveOwnRevenue}=require('../revenue-authorization-policy');
const admin={actor_type:'company',scope:'company',company_id:38,membership_id:9,role_code:'company_admin',permissions:['economics.approve']};
test('excepción requiere administrador empresarial efectivo, membresía y permiso existentes en la empresa correcta',()=>{
 assert.equal(canResolveOwnRevenue({user:admin},38),true);
 assert.equal(canResolveOwnRevenue({user:{...admin,role_code:'manager'}},38),true);
 assert.equal(canResolveOwnRevenue({user:{...admin,role_code:'manager',permissions:[]}},38),false);
 for(const patch of [{role_code:'operations'},{role_code:'administrative'},{role_code:'admin'},{permissions:[]},{membership_id:null},{scope:'platform'},{actor_type:'platform'},{company_id:39}])assert.equal(canResolveOwnRevenue({user:{...admin,...patch}},38),false,JSON.stringify(patch));
 assert.equal(canResolveOwnRevenue({user:null},38),false);
});
