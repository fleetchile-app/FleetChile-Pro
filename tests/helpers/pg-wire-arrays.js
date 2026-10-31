'use strict';
// Exercise node-postgres array parsers against the type OIDs returned by PGlite.
// This is not a replacement for a native PostgreSQL connection test.
const {types}=require('pg'),{prepareValue}=require('pg/lib/utils');
function pgWireArrays(pool){
 const query=async(sql,args)=>{
  const r=await pool.query(sql,args);
  return {...r,rows:r.rows.map(row=>{const out={...row};for(const field of r.fields||[]){const v=row[field.name];if(Array.isArray(v)&&[1003,1009].includes(field.dataTypeID))out[field.name]=types.getTypeParser(field.dataTypeID)(prepareValue(v));}return out;})};
 };
 return {query,connect:async()=>({query,release(){}})};
}
module.exports={pgWireArrays};
