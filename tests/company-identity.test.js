const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function loadIdentity(){const elements={activeCompanyName:{},activeCompanyMark:{},activeCompanyUser:{}};const context={Auth:{user:null},document:{getElementById:id=>elements[id]||null,querySelector:()=>null},localStorage:{getItem(){return''},setItem(){},removeItem(){}},fetch(){},Headers};context.window=context;context.addEventListener=()=>{};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'..','public','auth.js'),'utf8'),context);return {context,elements}}

test('identidad activa usa company_name real, usuario y fallback visual sin alterar company_id',()=>{const {context,elements}=loadIdentity();const user={id:7,name:'Ana Pérez',company_id:10,company_name:'Transportes del Sur',role_code:'operations'};context.renderActiveIdentity(user);assert.equal(elements.activeCompanyName.textContent,'Transportes del Sur');assert.equal(elements.activeCompanyMark.textContent,'TD');assert.equal(elements.activeCompanyUser.textContent,'Usuario: Ana Pérez');assert.equal(user.company_id,10)});

test('admin sin empresa no recibe una empresa inventada',()=>{const {context,elements}=loadIdentity();context.renderActiveIdentity({id:1,name:'Administrador',company_id:null,company_name:null,role_code:'admin'});assert.equal(elements.activeCompanyName.textContent,'Administración transversal');assert.equal(elements.activeCompanyMark.textContent,'AT')});
