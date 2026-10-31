'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root=path.resolve(__dirname,'..'),res=path.join(root,'android/app/src/main/res');
const {densities}=require('../scripts/icons');
test('icono elegido se conserva como PNG maestro cuadrado sin metadatos personales',async()=>{
 const image=await sharp(path.join(root,'assets/icon-source.png')).metadata();
 assert.equal(image.format,'png');assert.equal(image.width,1024);assert.equal(image.height,1024);assert.equal(image.exif,undefined);
});
test('cada densidad tiene icono normal y redondo con dimensiones correctas',async()=>{
 for(const [density,size] of Object.entries(densities))for(const name of ['ic_launcher','ic_launcher_round']){
  const image=await sharp(path.join(res,'mipmap-'+density,name+'.png')).metadata();
  assert.equal(image.format,'png');assert.equal(image.width,size);assert.equal(image.height,size);
 }
});
test('capa adaptable centra el original, sin estiramiento ni redibujo',async()=>{
 const file=path.join(res,'drawable-nodpi/ic_fleet_foreground.png'),m=await sharp(file).metadata();
 assert.equal(m.width,864);assert.equal(m.height,864);assert.equal(m.hasAlpha,true);
 const expected=await sharp(path.join(root,'assets/icon-source.png')).resize(480).ensureAlpha().raw().toBuffer();
 const actual=await sharp(file).extract({left:192,top:192,width:480,height:480}).raw().toBuffer();
 assert.deepEqual(actual,expected);
 const corner=await sharp(file).extract({left:0,top:0,width:1,height:1}).raw().toBuffer();assert.equal(corner[3],0);
});
test('Android usa los recursos nuevos y conserva identificador para actualizar sin desinstalar',()=>{
 const manifest=fs.readFileSync(path.join(res,'../AndroidManifest.xml'),'utf8');
 assert.match(manifest,/android:icon="@mipmap\/ic_launcher"/);assert.match(manifest,/android:roundIcon="@mipmap\/ic_launcher_round"/);
 for(const name of ['ic_launcher','ic_launcher_round'])assert.match(fs.readFileSync(path.join(res,'mipmap-anydpi-v26',name+'.xml'),'utf8'),/@drawable\/ic_fleet_foreground/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'capacitor.config.json'))).appId,'cl.fleetchile.driver');
});
