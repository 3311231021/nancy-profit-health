const db = require('./database');
const TYPES = ['hourly', 'monthly', 'lesson'];
function validPay(p) {
  return p && TYPES.includes(p.pay_type) && typeof p.rate === 'number' && Number.isFinite(p.rate) && p.rate >= 0 && p.rate <= 99999999 && Math.abs(p.rate * 100 - Math.round(p.rate * 100)) < 0.00001 && Number.isInteger(p.lessons ?? 0) && (p.lessons ?? 0) >= 0 && (p.lessons ?? 0) <= 10000;
}
function amount(type, rate, hours, lessons) {
  return Math.round((type === 'hourly' ? rate * hours : type === 'lesson' ? rate * lessons : rate) * 100) / 100;
}
function currentMonth() { return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Taipei', year:'numeric', month:'2-digit'}).format(new Date()); }
module.exports = function(app, {auth, requireRole}) {
  const staff = (req,res,next) => ['admin','expert'].includes(req.user.role) ? next() : res.status(403).json({message:'僅供管理員與專家使用'});
  const wrap = fn => async (req,res,next) => { try { await fn(req,res); } catch(e) { if(e.code === '23505') return res.status(409).json({message:'已上班，請先完成下班打卡'}); next(e); } };
  app.post('/api/expert/attendance/:action', auth, requireRole('expert'), wrap(async(req,res) => {
    let result;
    if(req.params.action === 'in') result = await db.query('INSERT INTO expert_attendance(user_id) VALUES (?) RETURNING *',[req.user.id]);
    else if(req.params.action === 'out') result = await db.query('UPDATE expert_attendance SET clock_out=NOW() WHERE user_id=? AND clock_out IS NULL RETURNING *',[req.user.id]);
    else return res.status(400).json({message:'無效的打卡操作'});
    if(!result.rowCount) return res.status(409).json({message:'尚未上班，無法下班打卡'});
    res.json({message:req.params.action === 'in' ? '上班打卡完成' : '下班打卡完成'});
  }));
  app.put('/api/admin/payroll/:id', auth, requireRole('admin'), wrap(async(req,res) => {
    const p=req.body, month=p?.month;
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') || !validPay(p)) return res.status(400).json({message:'請填寫月份、計薪方式、有效金額（最多兩位小數）與整數堂數'});
    const result=await db.query(`INSERT INTO expert_payroll(user_id,month,pay_type,rate,lessons,updated_by)
      SELECT id,?::date,?,?,?,? FROM users WHERE id=? AND role='expert'
      ON CONFLICT(user_id,month) DO UPDATE SET pay_type=EXCLUDED.pay_type,rate=EXCLUDED.rate,lessons=EXCLUDED.lessons,updated_by=EXCLUDED.updated_by,updated_at=NOW() RETURNING user_id`,[month+'-01',p.pay_type,p.rate,p.lessons ?? 0,req.user.id,req.params.id]);
    if(!result.rowCount) return res.status(404).json({message:'找不到專家'});
    res.json({message:'已儲存該月份計薪設定'});
  }));
  app.get('/api/payroll', auth, staff, wrap(async(req,res) => {
    const month=req.query.month || currentMonth();
    if(typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({message:'月份格式錯誤'});
    const start=month+'-01';
    const {rows}=await db.query(`WITH bounds AS (
      SELECT ?::date::timestamp AT TIME ZONE 'Asia/Taipei' AS start_at,
       (?::date + INTERVAL '1 month')::timestamp AT TIME ZONE 'Asia/Taipei' AS end_at)
      SELECT u.id,u.username,u.status,p.pay_type,p.rate,p.lessons,
      COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (LEAST(a.clock_out,b.end_at)-GREATEST(a.clock_in,b.start_at)))/3600)
      FROM expert_attendance a WHERE a.user_id=u.id AND a.clock_out IS NOT NULL AND a.clock_in < b.end_at AND a.clock_out > b.start_at),0) AS hours,
      (SELECT COUNT(*) FROM expert_attendance a WHERE a.user_id=u.id AND a.clock_out IS NULL) AS open_shifts
      FROM users u CROSS JOIN bounds b LEFT JOIN expert_payroll p ON p.user_id=u.id AND p.month=?::date
      WHERE u.role='expert' AND (?::integer IS NULL OR u.id=?::integer) ORDER BY u.id`,[start,start,start,req.user.role==='admin'?null:req.user.id,req.user.role==='admin'?null:req.user.id]);
    const attendance=await db.query(`SELECT a.id,a.user_id,u.username,a.clock_in,a.clock_out FROM expert_attendance a JOIN users u ON u.id=a.user_id
      WHERE (?::integer IS NULL OR a.user_id=?::integer) AND
      ((a.clock_in < (?::date + INTERVAL '1 month')::timestamp AT TIME ZONE 'Asia/Taipei'
      AND COALESCE(a.clock_out,NOW()) >= ?::date::timestamp AT TIME ZONE 'Asia/Taipei') OR a.clock_out IS NULL)
      ORDER BY a.clock_in DESC LIMIT 500`,[req.user.role==='admin'?null:req.user.id,req.user.role==='admin'?null:req.user.id,start,start]);
    res.json({month,rows:rows.map(r=>({...r,amount:r.pay_type?amount(r.pay_type,Number(r.rate),Number(r.hours),r.lessons):null})),attendance:attendance.rows});
  }));
};
module.exports.validPay=validPay;
module.exports.currentMonth=currentMonth;
module.exports.amount=amount;
