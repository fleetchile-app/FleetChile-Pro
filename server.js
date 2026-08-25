const express=require("express");
const {Pool}=require("pg");
const path=require("path");
const {registerCoreRoutes,initializeCorePlatform}=require("./core-api");
const {registerOperationsRoutes}=require("./operations-api");
const {registerFleetRoutes}=require("./fleet-api");
const {registerGeographyRoutes}=require("./geography-api");
const {createGeocoder}=require("./geocoding");
const {registerRoutingRoutes}=require("./routing-api");
const {createRoutingAdapter}=require("./routing");
const {registerHealthRoutes}=require("./health-api");
const {initializeDatabase,startApplication,logStartupError}=require("./startup");
const {registerAuthRoutes,authMiddleware,requirePermission}=require("./auth");
const {writeAudit}=require("./audit");
const {registerAdminRoutes}=require("./admin-api");
const {registerEconomicsRoutes}=require("./economics-api");
const app=express();const PORT=Number(process.env.PORT||3000);const DATABASE_URL=process.env.DATABASE_URL;
if(!DATABASE_URL){console.error("Falta DATABASE_URL. Define la variable de entorno antes de iniciar FleetChile.");process.exit(1)}
const pool=new Pool({connectionString:DATABASE_URL,max:Number(process.env.DB_POOL_MAX||10),idleTimeoutMillis:30000,connectionTimeoutMillis:10000,ssl:process.env.DATABASE_SSL==="true"?{rejectUnauthorized:false}:undefined});
pool.on('error',err=>console.error('PostgreSQL pool error:',err.message));
app.disable("x-powered-by");app.set("trust proxy",1);app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","SAMEORIGIN");res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");res.setHeader("Cache-Control",req.path.startsWith("/api/")?"no-store":"no-cache");next()});app.use(express.json({limit:"2mb"}));app.use(express.static(path.join(__dirname,"public"),{maxAge:0}));
const tables=["trucks","drivers","routes","loads","maintenance","fuel","alerts"];
const safeTable=name=>tables.includes(name);
const readPermissions={trucks:"dashboard.read",drivers:"drivers.manage",routes:"dashboard.read",loads:"loads.manage",maintenance:"maintenance.manage",fuel:"fuel.manage",alerts:"dashboard.read"};
const writePermissions={trucks:"fleet.manage",drivers:"drivers.manage",routes:"trips.manage",loads:"loads.manage",maintenance:"maintenance.manage",fuel:"fuel.manage",alerts:"fleet.manage"};
const requireTablePermission=permissions=>(req,res,next)=>{const code=permissions[req.params.table];if(!code)return res.sendStatus(404);return requirePermission(code)(req,res,next)};
const isAdmin=req=>req.user?.role_code==='admin';
const companyId=req=>isAdmin(req)?(req.body?.company_id||null):(req.user?.company_id||null);
const requireCreationCompany=(req,res,next)=>{const cid=companyId(req);if(!cid)return res.status(400).json({error:'company_id es obligatorio para crear este recurso'});req.resourceCompanyId=cid;next()};
async function legacyTruckBelongs(pool,truck,cid){if(!truck)return true;const value=String(truck).trim();const q=/^\d+$/.test(value)?'select id from trucks where id=$1 and company_id=$2':'select id from trucks where patente=$1 and company_id=$2';const r=await pool.query(q,[value,cid]);return !!r.rowCount}
async function createLegacyLoad(req,res,pool){
 const{client,guide,cargo,weight_kg=0,volume_m3=0,value_clp=0,truck,origin,destination,status="Planificada"}=req.body;
 if(truck&&!await legacyTruckBelongs(pool,truck,req.resourceCompanyId))return res.status(403).json({error:"El camión no pertenece a la empresa de la carga"});
 const db=await pool.connect();
 try{await db.query('BEGIN');const r=await db.query("insert into loads(company_id,client,guide,cargo,weight_kg,volume_m3,value_clp,truck,origin,destination,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *",[req.resourceCompanyId,client||null,guide||null,cargo||null,weight_kg,volume_m3,value_clp,truck||null,origin||null,destination||null,status]);await writeAudit(db,req,{companyId:req.resourceCompanyId,action:'create',entity:'loads',entityId:r.rows[0].id,afterData:r.rows[0]});await db.query('COMMIT');res.status(201).json(r.rows[0])}catch(e){await db.query('ROLLBACK');res.status(400).json({error:"No se pudo crear la carga"})}finally{db.release()}
}
const parseLegacyCoordinate=value=>{
 if(typeof value!=='number'&&typeof value!=='string')return null;
 if(typeof value==='string'&&value.trim()==='')return null;
 const number=Number(value);
 return Number.isFinite(number)?number:null;
};
async function updateLegacyTruckLocation(req,res,pool){
 const{location,km,status,speed_kmh=0}=req.body;
 if(req.body.lat===null||req.body.lat===undefined||req.body.lng===null||req.body.lng===undefined)return res.status(400).json({error:"lat y lng son obligatorios"});
 const lat=parseLegacyCoordinate(req.body.lat),lng=parseLegacyCoordinate(req.body.lng);
 if(lat===null||lat<-90||lat>90||lng===null||lng<-180||lng>180)return res.status(400).json({error:"lat o lng no válidos"});
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const params=isAdmin(req)?[lat,lng,location,km,status,req.params.id]:[lat,lng,location,km,status,req.params.id,companyId(req)];
  const filter=isAdmin(req)?'where id=$6':'where id=$6 and company_id=$7';
  const r=await db.query(`update trucks set lat=coalesce($1,lat),lng=coalesce($2,lng),location=coalesce($3,location),km=coalesce($4,km),status=coalesce($5,status) ${filter} returning *`,params);
  if(!r.rowCount){await db.query('ROLLBACK');return res.sendStatus(404)}
  await db.query("insert into telemetry(truck_id,lat,lng,speed_kmh,km,recorded_at) values($1,$2,$3,$4,$5,now())",[req.params.id,lat,lng,speed_kmh,km??r.rows[0].km??0]);
  await db.query('COMMIT');
  res.json(r.rows[0]);
 }catch(e){
  await db.query('ROLLBACK');
  res.status(400).json({error:"No se pudo actualizar la posición GPS"});
 }finally{db.release()}
}

registerAuthRoutes(app,pool);
registerHealthRoutes(app,pool);
app.use("/api",authMiddleware.bind(null,pool));
registerCoreRoutes(app,pool);
registerOperationsRoutes(app,pool);
registerFleetRoutes(app,pool);
registerGeographyRoutes(app,pool,createGeocoder());
registerRoutingRoutes(app,pool,createRoutingAdapter());
registerAdminRoutes(app,pool);
registerEconomicsRoutes(app,pool);

app.get("/api/dashboard",requirePermission("dashboard.read"),async(req,res)=>{try{const scoped=isAdmin(req)?{clause:'',values:[]}:{clause:' where company_id=$1',values:[companyId(req)]};const q=async sql=>Number((await pool.query(sql,scoped.values)).rows[0].n||0);res.json({trucks:await q(`select count(*) n from trucks${scoped.clause}`),enroute:await q(`select count(*) n from trucks${scoped.clause}${scoped.clause?' and':' where'} status='En ruta'`),loads:await q(`select count(*) n from loads${scoped.clause}`),alerts:await q(`select count(*) n from alerts${scoped.clause}${scoped.clause?' and':' where'} resolved=false`),fuel:await q(`select coalesce(sum(total_clp),0) n from fuel${scoped.clause}`),km:await q(`select coalesce(sum(km),0) n from trucks${scoped.clause}`)})}catch(e){res.status(500).json({error:"No se pudo cargar el dashboard"})}});

// LEGACY: /api/:table solo mantiene compatibilidad con módulos existentes. Los módulos nuevos no deben usar CRUD genérico.
app.get("/api/:table",requireTablePermission(readPermissions),async(req,res)=>{if(!safeTable(req.params.table))return res.sendStatus(404);try{if(isAdmin(req))return res.json((await pool.query(`select * from ${req.params.table} order by id desc`)).rows);res.json((await pool.query(`select * from ${req.params.table} where company_id=$1 order by id desc`,[companyId(req)])).rows)}catch(e){res.status(500).json({error:"No se pudo consultar la información"})}});

app.get("/api/trucks/:id/history",requirePermission("gps.read"),async(req,res)=>{try{const params=isAdmin(req)?[req.params.id]:[req.params.id,companyId(req)];const companyFilter=isAdmin(req)?'':' and t.company_id=$2';res.json((await pool.query(`select telemetry.* from telemetry join trucks t on t.id=telemetry.truck_id where telemetry.truck_id=$1${companyFilter} order by recorded_at desc limit 100`,params)).rows)}catch(e){res.status(500).json({error:"No se pudo consultar el historial GPS"})}});

app.post("/api/trucks",requirePermission("fleet.manage"),requireCreationCompany,async(req,res)=>{const{patente,tipo,capacidad_t,driver,status="Disponible",km=0,lat=null,lng=null,location=""}=req.body;if(!patente||!tipo||capacidad_t===undefined)return res.status(400).json({error:"patente, tipo y capacidad_t son obligatorios"});try{const r=await pool.query("insert into trucks(company_id,patente,tipo,capacidad_t,driver,status,km,lat,lng,location) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *",[req.resourceCompanyId,patente.trim().toUpperCase(),tipo,capacidad_t,driver||null,status,km,lat,lng,location]);res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:e.code==="23505"?"La patente ya existe":"No se pudo crear el camión"})}});
app.patch("/api/trucks/:id/location",requirePermission("fleet.manage"),(req,res)=>updateLegacyTruckLocation(req,res,pool));

app.post("/api/routes",requirePermission("trips.manage"),requireCreationCompany,async(req,res)=>{const{truck,origin,destination,distance_km=0,progress=0,status="Planificada",eta=null}=req.body;const client=await pool.connect();try{await client.query('BEGIN');if(truck&&!await legacyTruckBelongs(client,truck,req.resourceCompanyId)){await client.query('ROLLBACK');return res.status(403).json({error:"El camión no pertenece a la empresa de la ruta"})}const r=await client.query("insert into routes(company_id,truck,origin,destination,distance_km,progress,status,eta) values($1,$2,$3,$4,$5,$6,$7,$8) returning *",[req.resourceCompanyId,truck||null,origin||null,destination||null,distance_km,progress,status,eta]);await writeAudit(client,req,{companyId:req.resourceCompanyId,action:'create',entity:'route',entityId:r.rows[0].id,afterData:r.rows[0]});await client.query('COMMIT');res.status(201).json(r.rows[0])}catch(e){await client.query('ROLLBACK');res.status(400).json({error:"No se pudo crear la ruta"})}finally{client.release()}});
app.post("/api/loads",requirePermission("loads.manage"),requireCreationCompany,(req,res)=>createLegacyLoad(req,res,pool));
app.post("/api/fuel",requirePermission("fuel.manage"),requireCreationCompany,async(req,res)=>{const{date,truck,liters,price_clp,station}=req.body;if(truck&&!await legacyTruckBelongs(pool,truck,req.resourceCompanyId))return res.status(403).json({error:"El camión no pertenece a la empresa del registro de combustible"});try{const r=await pool.query("insert into fuel(company_id,date,truck,liters,price_clp,total_clp,station) values($1,$2,$3,$4,$5,$4*$5,$6) returning *",[req.resourceCompanyId,date||null,truck||null,liters||0,price_clp||0,station||null]);res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:"No se pudo registrar el combustible"})}});
app.post("/api/maintenance",requirePermission("maintenance.manage"),requireCreationCompany,async(req,res)=>{const{truck,item,due,cost_clp=0,status="Pendiente"}=req.body;if(truck&&!await legacyTruckBelongs(pool,truck,req.resourceCompanyId))return res.status(403).json({error:"El camión no pertenece a la empresa de la mantención"});try{const r=await pool.query("insert into maintenance(company_id,truck,item,due,cost_clp,status) values($1,$2,$3,$4,$5,$6) returning *",[req.resourceCompanyId,truck||null,item||null,due||null,cost_clp,status]);res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:"No se pudo registrar la mantención"})}});
// LEGACY: CRUD genérico. No utilizar en módulos nuevos de Fases 3-6.
app.delete("/api/:table/:id",requireTablePermission(writePermissions),async(req,res)=>{if(!safeTable(req.params.table))return res.sendStatus(404);const client=await pool.connect();try{await client.query('BEGIN');const params=isAdmin(req)?[req.params.id]:[req.params.id,companyId(req)];const filter=isAdmin(req)?'where id=$1':'where id=$1 and company_id=$2';const r=await client.query(`delete from ${req.params.table} ${filter} returning *`,params);if(!r.rowCount){await client.query('ROLLBACK');return res.sendStatus(404)}const before=r.rows[0];await writeAudit(client,req,{companyId:before.company_id,action:'delete',entity:req.params.table,entityId:req.params.id,beforeData:before});await client.query('COMMIT');res.sendStatus(204)}catch(e){await client.query('ROLLBACK');res.status(400).json({error:"No se pudo eliminar el registro"})}finally{client.release()}});

app.get("/driver",(req,res)=>res.sendFile(path.join(__dirname,"public","driver.html")));
app.use((req,res,next)=>{if(req.method==="GET"&&!req.path.startsWith("/api/"))return res.sendFile(path.join(__dirname,"public","index.html"));next()});
async function start(){const server=await startApplication({app,pool,port:PORT,initialize:()=>initializeDatabase(pool,{initializeCorePlatform})});const shutdown=async()=>{server.close(async()=>{await pool.end();process.exit(0)})};process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown)}
start().catch(err=>{logStartupError(console,err);process.exit(1)});
