'use strict';
// Deterministic format/size conversion: never redraw the chosen artwork.
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root=path.resolve(__dirname,'..'),assets=path.join(root,'assets');
const resource=path.join(root,'android/app/src/main/res');
const master=path.join(assets,'icon-source.png');
const densities={mdpi:48,hdpi:72,xhdpi:96,xxhdpi:144,xxxhdpi:192};
async function generate(input){
 fs.mkdirSync(assets,{recursive:true});
 if(input){
  const png=await sharp(path.resolve(input)).rotate().resize(1024,1024,{fit:'contain',background:'#ffffff'}).png().toBuffer();
  await sharp(png).toFile(master);
 }
 if(!fs.existsSync(master))throw Error('Importa primero la imagen elegida: node scripts/icons.js RUTA_IMAGEN');
 for(const [density,size] of Object.entries(densities)){
  const dir=path.join(resource,'mipmap-'+density);fs.mkdirSync(dir,{recursive:true});
  await sharp(master).resize(size,size).png().toFile(path.join(dir,'ic_launcher.png'));
  const picture=await sharp(master).resize(Math.round(size*.78)).toBuffer();
  const mask=Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="white"/></svg>`);
  const round=await sharp({create:{width:size,height:size,channels:4,background:'#0b2745'}}).composite([{input:picture,gravity:'centre'}]).png().toBuffer();
  await sharp(round).composite([{input:mask,blend:'dest-in'}]).png().toFile(path.join(dir,'ic_launcher_round.png'));
 }
 // 108 dp layer, artwork at 60 dp; launcher masks may trim the outer frame,
 // but the truck/FC stay inside the protected central area.
 const foreground=await sharp(master).resize(480).toBuffer();
 const dir=path.join(resource,'drawable-nodpi');fs.mkdirSync(dir,{recursive:true});
 await sharp({create:{width:864,height:864,channels:4,background:'#00000000'}}).composite([{input:foreground,gravity:'centre'}]).png().toFile(path.join(dir,'ic_fleet_foreground.png'));
 // Preview the 72 dp visible viewport, not the full 108 dp parallax layer.
 const viewport=await sharp(path.join(dir,'ic_fleet_foreground.png')).extract({left:144,top:144,width:576,height:576}).resize(256).toBuffer();
 const previews=[];
 for(const [i,shape] of ['<circle cx="128" cy="128" r="126" fill="white"/>','<rect x="2" y="2" width="252" height="252" rx="58" fill="white"/>','<rect x="2" y="2" width="252" height="252" fill="white"/>'].entries()){
  const base=await sharp({create:{width:256,height:256,channels:4,background:'#0b2745'}}).composite([{input:viewport}]).png().toBuffer();
  const clipped=await sharp(base).composite([{input:Buffer.from(`<svg width="256" height="256">${shape}</svg>`),blend:'dest-in'}]).png().toBuffer();
  previews.push({input:clipped,left:i*280+12,top:12});
 }
 await sharp({create:{width:840,height:280,channels:4,background:'#f2f5f8'}}).composite(previews).png().toFile(path.join(assets,'icon-preview.png'));
 console.log('Iconos PNG y capas adaptables generados desde la imagen original, sin redibujar.');
}
if(require.main===module)generate(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={generate,densities};
