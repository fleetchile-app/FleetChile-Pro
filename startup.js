const fs=require('fs');
const path=require('path');

const MIGRATION_FILES=['003_auth_rbac.sql','004_operations.sql','005_trip_links.sql','006_admin_settings.sql','007_preflight_integrity.sql','008_fleet_phase3_gps.sql','009_operational_geography.sql','010_road_routing.sql','011_trip_route_snapshots.sql','012_fuel_operations.sql','013_maintenance_operations.sql'];

function timeoutMs(value,fallback){
  const parsed=Number(value);
  return Number.isInteger(parsed)&&parsed>0?parsed:fallback;
}

function migrationTimeouts(env=process.env){
  return {lockTimeoutMs:timeoutMs(env.MIGRATION_LOCK_TIMEOUT_MS,5000),statementTimeoutMs:timeoutMs(env.MIGRATION_STATEMENT_TIMEOUT_MS,120000)};
}

async function initializeDatabase(pool,{baseDir=__dirname,initializeCorePlatform,logger=console,env=process.env}={}){
  let db;
  let stage='conexión PostgreSQL';
  let startupError;
  try{
    db=await pool.connect();
    await db.query('select 1');
    logger.log('[STARTUP] conexión PostgreSQL inicializada');
    const {lockTimeoutMs,statementTimeoutMs}=migrationTimeouts(env);
    await db.query("select set_config('lock_timeout',$1,false),set_config('statement_timeout',$2,false)",[`${lockTimeoutMs}ms`,`${statementTimeoutMs}ms`]);
    logger.log(`[STARTUP] timeouts configurados: lock=${lockTimeoutMs}ms statement=${statementTimeoutMs}ms`);

    stage='schema.sql';
    await db.query(fs.readFileSync(path.join(baseDir,'schema.sql'),'utf8'));
    logger.log('[STARTUP] schema inicializado');

    stage='seed';
    const {rows}=await db.query('select count(*)::int as count from trucks');
    if(rows[0].count===0){
      await db.query(fs.readFileSync(path.join(baseDir,'seed.sql'),'utf8'));
      logger.log('[STARTUP] datos demo inicializados');
    }

    stage='core platform';
    await initializeCorePlatform(db);
    logger.log('[STARTUP] core platform inicializada');

    for(const file of MIGRATION_FILES){
      stage=`migración ${file}`;
      logger.log(`[STARTUP] migración ${file} iniciada`);
      await db.query(fs.readFileSync(path.join(baseDir,'migrations',file),'utf8'));
      logger.log(`[STARTUP] migración ${file} completada`);
    }
  }catch(error){
    error.startupStage=stage;
    startupError=error;
  }finally{
    if(db){
      let cleanupError;
      try{
        await db.query('RESET lock_timeout; RESET statement_timeout');
        logger.log('[STARTUP] timeouts de migración restaurados');
      }catch(error){
        cleanupError=error;
        if(typeof logger.error==='function')logger.error(`[STARTUP CLEANUP ERROR] ${error.message}`);
      }
      db.release(cleanupError);
      if(cleanupError&&!startupError){
        cleanupError.startupStage='limpieza de timeouts PostgreSQL';
        startupError=cleanupError;
      }
    }
  }
  if(startupError)throw startupError;
}

async function startApplication({app,pool,port,initialize,logger=console}){
  logger.log('[STARTUP] iniciado');
  await initialize();
  return app.listen(port,()=>logger.log(`[STARTUP] servidor escuchando en puerto ${port}`));
}

function logStartupError(logger,error){
  const stage=error?.startupStage?` etapa=${error.startupStage}`:'';
  logger.error(`[STARTUP ERROR]${stage} ${error?.message||'Error desconocido'}`);
  if(error?.stack)logger.error(error.stack);
}

module.exports={MIGRATION_FILES,initializeDatabase,startApplication,logStartupError,migrationTimeouts};
