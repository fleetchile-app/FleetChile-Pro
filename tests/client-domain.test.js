const test=require('node:test');
const assert=require('node:assert/strict');
const {identifier,validateClient,validateDocument}=require('../client-domain');
const pdf=Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');
const client={name:'Cliente prueba',rut:'12.345.678-5'};
const doc={kind:'signed',filename:'compromiso.pdf',content:pdf.toString('base64'),reason:'Respaldo recibido',signer_name:'Representante',signed_on:'2026-10-20'};
test('cliente exige identidad/RUT válido y normaliza sin inventar datos opcionales',()=>{
 assert.deepEqual(validateClient(client),{name:'Cliente prueba',rut:'12345678-5',normalized_rut:'12345678-5',identity_type:'company',relationship:'customer'});
 for(const body of [{},{...client,name:''},{...client,rut:'12345678-0'},{...client,rut:null}])assert.throws(()=>validateClient(body),e=>e.status===400);
 assert.deepEqual(validateClient({email:null},{partial:true}),{email:null});
});
test('enlaces, códigos, textos y opciones se validan por lista permitida',()=>{
 for(const fields of [{client_code:'bad space'},{website:'javascript:alert(1)'},{social_url:'https://user:pass@example.test'},{email:'not-email'},{segment:'driver'},{relationship:''},{active:'false'},{phone:'x\nheader'},{name:'x'.repeat(201)}])assert.throws(()=>validateClient({...client,...fields}),e=>e.status===400);
 assert.equal(validateClient({...client,client_code:'CLI-manual_1',website:'https://example.test'}).website,'https://example.test/');
 assert.equal(validateClient({...client,segment:'wholesale',relationship:'recurring'}).relationship,'recurring');
});
test('autoridad empresarial y privacidad no pueden inyectarse en la ficha',()=>{
 for(const key of ['company_id','normalized_rut','created_at','updated_at','privacy_status'])assert.throws(()=>validateClient({...client,[key]:'attack'}),e=>e.status===400);
 for(const value of [0,-1,'1;drop table clients','90071992547409999999999999',Number.MAX_SAFE_INTEGER+1,[7],{toString:()=> '7'}])assert.throws(()=>identifier(value));
 assert.equal(identifier('9007199254740993'),'9007199254740993');
 assert.equal(validateClient({...client,assigned_person_id:'9007199254740993'}).assigned_person_id,'9007199254740993');
});
test('PDF conserva hash exacto y distingue plantilla de respaldo firmado',()=>{
 const signed=validateDocument(doc,'2026-10-22');assert.deepEqual(signed.buffer,pdf);assert.match(signed.sha256,/^[0-9a-f]{64}$/);assert.equal(signed.signed_on,'2026-10-20');
 const template=validateDocument({...doc,kind:'template',signer_name:'',signed_on:null},'2026-10-22');assert.equal(template.signer_name,null);assert.equal(template.signed_on,null);
});
test('rechaza archivos incorrectos, grandes, base64 no canónico y metadatos incompletos',()=>{
 for(const patch of [{kind:'image'},{reason:''},{filename:'../../x.pdf'},{filename:'script.html'},{content:'%%%%'},{content:Buffer.from('<script>evil</script>').toString('base64')},{content:Buffer.from('%PDF-1.4 no footer').toString('base64')},{content:'A'.repeat(1398108)},{signer_name:''},{signed_on:'2026-02-30'},{signed_on:'2027-01-01'}])assert.throws(()=>validateDocument({...doc,...patch},'2026-10-22'),e=>e.status===400);
 const max=Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.alloc(1048576-15,32),Buffer.from('\n%%EOF')]);assert.equal(max.length,1048576);assert.equal(validateDocument({...doc,content:max.toString('base64')},'2026-10-22').buffer.length,1048576);
});
