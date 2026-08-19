const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');

const IGNORED_DIRECTORIES=new Set(['.git','node_modules','tests']);

function collectJavaScriptFiles(directory,files=[]){
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    if(entry.isDirectory()&&IGNORED_DIRECTORIES.has(entry.name))continue;
    const absolute=path.join(directory,entry.name);
    if(entry.isDirectory())collectJavaScriptFiles(absolute,files);
    else if(entry.isFile()&&entry.name.endsWith('.js'))files.push(absolute);
  }
  return files.sort();
}

function checkSyntax(files,{spawn=spawnSync,logger=console}={}){
  for(const file of files){
    logger.log(`[SYNTAX] ${path.relative(process.cwd(),file)}`);
    const result=spawn(process.execPath,['--check',file],{stdio:'inherit'});
    if(result.error)throw result.error;
    if(result.status!==0)throw new Error(`Validación sintáctica fallida: ${file}`);
  }
}

if(require.main===module){
  try{checkSyntax(collectJavaScriptFiles(process.cwd()));console.log('[SYNTAX] validación completada')}catch(error){console.error(`[SYNTAX ERROR] ${error.message}`);process.exit(1)}
}

module.exports={collectJavaScriptFiles,checkSyntax};
