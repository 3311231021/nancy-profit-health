const {Pool,types}=require('pg');
types.setTypeParser(20,Number); types.setTypeParser(1700,Number); types.setTypeParser(1082,String);
let connection;
async function pool() {
  if (!connection) {
    connection = (async () => {
      const {getConnectionString} = await import('@netlify/database');
      let connectionString;
      try {
        connectionString = getConnectionString();
      } catch (error) {
        if (error.name !== 'MissingDatabaseConnectionError') throw error;
        connectionString = process.env.NETLIFY_DB_URL || process.env.DATABASE_URL;
        if (!connectionString) throw error;
      }
      return new Pool({connectionString,max:2,idleTimeoutMillis:10000,connectionTimeoutMillis:10000});
    })().catch(error => {
      connection = undefined;
      throw error;
    });
  }
  return connection;
}
function placeholders(sql){let quoted=false,i=0,result='';for(let k=0;k<sql.length;k++){const c=sql[k];if(c==="'"){result+=c;if(quoted&&sql[k+1]==="'"){result+=sql[++k];continue;}quoted=!quoted;}else result+=c==='?'&&!quoted?'$'+(++i):c;}return result;}
async function query(sql,params=[]){return(await pool()).query(placeholders(sql),params);}
function execute(mode,sql,params,callback){if(typeof params==='function'){callback=params;params=[];}if(mode==='run'&&/^\s*INSERT\s+INTO/i.test(sql)&&!/\bRETURNING\b/i.test(sql)){sql+=/^\s*INSERT\s+INTO\s+goals\b/i.test(sql)?' RETURNING user_id':' RETURNING id';}query(sql,params).then(r=>{if(mode==='run')callback?.call({lastID:r.rows[0]?.id,changes:r.rowCount},null);else callback?.(null,mode==='get'?r.rows[0]:r.rows);},error=>callback?.(error));}
module.exports={all:(s,p,c)=>execute('all',s,p,c),get:(s,p,c)=>execute('get',s,p,c),run:(s,p,c)=>execute('run',s,p,c),query,pool,placeholders,setPoolForTest(p){if(process.env.NODE_ENV!=='test')throw Error('Test only');connection=Promise.resolve(p);}};
