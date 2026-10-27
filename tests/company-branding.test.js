'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const {validateSettings,normalizeLogo,identitySnapshot,PALETTES}=require('../company-branding');
const payload={expected_version:0,display_name:'Mi empresa',palette:'ocean',contact_name:'Contacto',contact_email:'test@example.invalid',contact_phone:'+56 9 12345678',reason:'Identidad inicial'};
test('todas las paletas mantienen contraste AA con texto blanco',()=>{
 for(const color of Object.values(PALETTES)){const rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4),l=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];assert.ok(1.05/(l+.05)>=4.5,color);}
});
test('configuración restringida: no admite identidad contractual, empresa ajena o paletas arbitrarias',()=>{
 assert.equal(validateSettings(payload).display_name,'Mi empresa');
 for(const patch of [{company_id:5},{rut:'123'},{legal_name:'Otra'},{expected_version:'0'},{expected_version:-1},{palette:'red'},{contact_email:'no-correo'},{reason:'x'},{display_name:'x\n<script>'},{display_name:'x'.repeat(121)},{reset:'true'}])assert.throws(()=>validateSettings({...payload,...patch}),e=>e.status===400);
 assert.deepEqual(validateSettings({...payload,reset:true}),{display_name:'',palette:'ocean',contact_name:'',contact_email:'',contact_phone:'',logo:null,reason:payload.reason});
});
test('logo se decodifica, limita, elimina metadatos y transforma en JPEG estático apto para PDF',async()=>{
 const source=await sharp({create:{width:1200,height:400,channels:4,background:'#23634c80'}}).png().toBuffer();
 const logo=await normalizeLogo('data:image/png;base64,'+source.toString('base64'));
 assert.equal(logo.logo_width,600);assert.equal(logo.logo_height,200);
 const m=await sharp(logo.logo).metadata();assert.equal(m.format,'jpeg');assert.equal(m.hasAlpha,false);assert.equal(m.exif,undefined);
 const snapshot=identitySnapshot({company_id:1,logo:logo.logo});assert.match(snapshot.logo_sha256,/^[a-f0-9]{64}$/);assert.equal(snapshot.logo,undefined);
 assert.deepEqual(await normalizeLogo(null),{logo:null,logo_width:null,logo_height:null});
 for(const value of ['https://example.invalid/logo.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,YmFk','data:image/png;base64,'+'A'.repeat(1400004)])await assert.rejects(()=>normalizeLogo(value),e=>e.status===400);
 await assert.rejects(()=>normalizeLogo('data:image/png;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')),e=>e.status===400);
});
