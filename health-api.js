function registerHealthRoutes(app,pool){
  app.get('/api/health',(req,res)=>res.json({ok:true,service:'fleetchile',status:'alive',time:new Date().toISOString()}));
  app.get('/api/ready',async(req,res)=>{try{await pool.query('select 1');res.json({ok:true,service:'fleetchile',status:'ready',time:new Date().toISOString()})}catch(error){res.status(503).json({ok:false,service:'fleetchile',status:'not_ready',error:'database_unavailable'})}});
}

module.exports={registerHealthRoutes};
