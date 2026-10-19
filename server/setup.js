const crypto=require('node:crypto'),bcrypt=require('bcryptjs'),db=require('./database');
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
module.exports=app=>{app.post('/api/setup',async(req,res)=>{
 const expected=process.env.SETUP_KEY;
 if(!expected||expected.length<32||!equal(req.get('X-Setup-Key'),expected))return res.status(403).json({message:'初始化金鑰不正確或尚未設定'});
 const {admin_email,password}=req.body||{};
 if(!admin_email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin_email)||typeof password!=='string'||password.length<12||Buffer.byteLength(password)>72)return res.status(400).json({message:'請填寫有效 Email 及至少 12 字元的密碼（最多 72 bytes）'});
 const email=admin_email.trim().toLowerCase();if(['demo-user@example.com','demo-expert@example.com'].includes(email))return res.status(400).json({message:'管理員請使用不同的 Email'});
 let client;
 try{
 client=await(await db.pool()).connect();await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(93871265)');
 const done=await client.query('SELECT id FROM profit_setup WHERE id=1');if(done.rows.length){await client.query('ROLLBACK');return res.status(409).json({message:'已完成初始化，不會覆蓋帳號或資料'});}
 const hash=await bcrypt.hash(password,10);
 const create=async(email,name,role)=>(await client.query('INSERT INTO users (email,password,username,role) VALUES ($1,$2,$3,$4) RETURNING id',[email,hash,name,role])).rows[0].id;
 const existing=(await client.query('SELECT id,role FROM users WHERE email=$1',[email])).rows[0];
 if(existing&&existing.role!=='user'){await client.query('ROLLBACK');return res.status(409).json({message:'此 Email 已被專家或管理員帳號使用'});}
 // 此 Email 已用註冊頁註冊成學員：升級為管理員，不另建帳號
 if(existing)await client.query("UPDATE users SET role='admin',password=$1,status='active' WHERE id=$2",[hash,existing.id]);else await create(email,'專題管理員','admin');const user=await create('demo-user@example.com','測試學員','user'),expert=await create('demo-expert@example.com','測試教練','expert');
 await client.query("INSERT INTO expert_profiles (user_id,specialty,title) VALUES ($1,'coach','教練')",[expert]);await client.query('INSERT INTO expert_assignments (expert_user_id,client_user_id) VALUES ($1,$2)',[expert,user]);await client.query('INSERT INTO goals (user_id) VALUES ($1)',[user]);await client.query('INSERT INTO health_records (user_id,height,weight,bmi) VALUES ($1,165,60,22.04)',[user]);
 for(let day=0;day<7;day++)await client.query("INSERT INTO activity_records (user_id,activity_type,duration,steps,calories,heart_rate,speed,created_at) VALUES ($1,'步行',$2,$3,$4,100,4,CURRENT_TIMESTAMP - ($5 * INTERVAL '1 day'))",[user,30+day,5000+day*300,150+day*10,day]);
 await client.query("INSERT INTO expert_notes (expert_user_id,client_user_id,note_type,content) VALUES ($1,$2,'feedback','這是專題展示用的測試回饋。')",[expert,user]);await client.query('INSERT INTO profit_setup (id) VALUES (1)');await client.query('COMMIT');res.json({message:'初始化成功，三個角色帳號已建立',accounts:{admin:email,user:'demo-user@example.com',expert:'demo-expert@example.com'}});
 }catch(error){if(client){try{await client.query('ROLLBACK');}catch{console.error('Setup rollback failed');}}console.error('Setup failed',{code:/^[A-Z0-9_]{1,40}$/.test(error.code||'')?error.code:undefined});res.status(500).json({message:'初始化失敗，請確認 migration 已套用；管理員 Email 也不能與既有帳號重複'});}finally{client?.release();}
});
app.post('/api/setup/reset-admin',async(req,res)=>{
 const expected=process.env.SETUP_KEY;
 if(!expected||expected.length<32||!equal(req.get('X-Setup-Key'),expected))return res.status(403).json({message:'初始化金鑰不正確或尚未設定'});
 const {admin_email,password}=req.body||{};
 if(!admin_email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin_email)||typeof password!=='string'||password.length<12||Buffer.byteLength(password)>72)return res.status(400).json({message:'請填寫有效 Email 及至少 12 字元的密碼（最多 72 bytes）'});
 const email=admin_email.trim().toLowerCase();if(['demo-user@example.com','demo-expert@example.com'].includes(email))return res.status(400).json({message:'管理員請使用不同的 Email'});
 let client;
 try{
 client=await(await db.pool()).connect();await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(93871265)');
 const admin=(await client.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0];
 const taken=(await client.query('SELECT id,role FROM users WHERE email=$1 AND id<>$2',[email,admin?admin.id:0])).rows[0];
 if(taken&&taken.role!=='user'){await client.query('ROLLBACK');return res.status(409).json({message:'此 Email 已被專家帳號使用'});}
 if(taken){
  // 此 Email 已用註冊頁註冊成一般學員帳號：直接升級為管理員
  await client.query("UPDATE users SET role='admin',password=$1,status='active' WHERE id=$2",[await bcrypt.hash(password,10),taken.id]);
  await client.query('COMMIT');return res.json({message:'此 Email 原本是學員帳號，已升級為管理員並重設密碼，請重新登入',accounts:{admin:email}});
 }
 if(!admin){
  // 初始化從未完成、資料庫中沒有管理員：直接建立管理員帳號
  await client.query("INSERT INTO users (email,password,username,role,status) VALUES ($1,$2,'專題管理員','admin','active')",[email,await bcrypt.hash(password,10)]);
  await client.query('COMMIT');return res.json({message:'資料庫中原本沒有管理員，已建立新的管理員帳號',accounts:{admin:email}});
 }
 await client.query("UPDATE users SET email=$1,password=$2,status='active' WHERE id=$3",[email,await bcrypt.hash(password,10),admin.id]);
 await client.query('COMMIT');res.json({message:'管理員帳密已重設',accounts:{admin:email}});
 }catch(error){if(client){try{await client.query('ROLLBACK');}catch{console.error('Admin reset rollback failed');}}console.error('Admin reset failed',{code:/^[A-Z0-9_]{1,40}$/.test(error.code||'')?error.code:undefined});res.status(500).json({message:'重設失敗，請稍後再試'});}finally{client?.release();}
});};
