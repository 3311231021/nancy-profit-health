(() => {
  const el = id => document.getElementById(id);
  const labels = {hourly:'兼職時薪',monthly:'固定月薪',lesson:'按堂計酬'};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let rows=[], role='', busy=false;
  el('month').value=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit'}).format(new Date());
  const money=value=>Number(value).toLocaleString('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2});
  const time=value=>new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});
  async function api(path,options={}) {
    const res=await fetch(path,{...options,headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('token')}});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.message || '目前無法讀取資料，請稍後再試');
    return data;
  }
  function fields(){
    const type=el('payType').value;
    el('rateLabel').textContent={hourly:'時薪（NT$／小時）',monthly:'月薪（NT$／月）',lesson:'每堂費用（NT$／堂）'}[type];
    el('lessonField').hidden=type!=='lesson';
  }
  function fill(){
    const row=rows.find(r=>String(r.id)===el('expert').value);
    el('payType').value=row?.pay_type || 'hourly';el('rate').value=row?.rate ?? '';el('lessons').value=row?.lessons ?? 0;fields();
  }
  async function load(){
    if(!el('month').value) throw new Error('請選擇月份');
    const data=await api('/api/payroll?month='+encodeURIComponent(el('month').value));rows=data.rows;
    el('summary').innerHTML=rows.map(r=>`<tr><td>${esc(r.username)}${r.status==='active'?'':'（停用）'}</td><td>${labels[r.pay_type] || '尚未設定'}</td><td>${r.rate===null?'—':money(r.rate)}</td><td>${Number(r.hours).toFixed(2)}</td><td>${r.pay_type==='lesson'?r.lessons:'—'}</td><td class="amount">${r.amount===null?'待設定':money(r.amount)}</td><td>${Number(r.open_shifts)?'上班中 · 工時待結算':'已下班'}</td></tr>`).join('') || '<tr><td colspan="7">目前沒有專家資料。</td></tr>';
    el('attendance').innerHTML=data.attendance.map(r=>`<tr><td>${esc(r.username)}</td><td>${time(r.clock_in)}</td><td>${r.clock_out?time(r.clock_out):'尚未下班'}</td></tr>`).join('') || '<tr><td colspan="3">此月尚無出勤紀錄。</td></tr>';
    if(role==='admin'){
      const selected=el('expert').value;
      el('expert').innerHTML=rows.map(r=>`<option value="${r.id}">${esc(r.username)}${r.status==='active'?'':'（停用）'}</option>`).join('');
      if(rows.some(r=>String(r.id)===selected)) el('expert').value=selected;
      fill();
    } else {
      const open=Number(rows[0]?.open_shifts)>0;
      el('clockIn').disabled=open;el('clockOut').disabled=!open;
    }
  }
  async function run(fn){
    if(busy)return;busy=true;el('message').textContent='處理中…';
    const buttons=[...document.querySelectorAll('button')];const states=buttons.map(b=>b.disabled);buttons.forEach(b=>b.disabled=true);
    let succeeded=false;
    try{await fn();succeeded=true;el('message').textContent='資料已更新。';}catch(e){el('message').textContent=e.message;}
    finally{busy=false;buttons.forEach((b,i)=>b.disabled=states[i]);if(succeeded&&role==='expert'){const open=Number(rows[0]?.open_shifts)>0;el('clockIn').disabled=open;el('clockOut').disabled=!open;}}
  }
  el('payType').onchange=fields;el('expert').onchange=fill;
  el('refresh').onclick=()=>run(load);el('month').onchange=()=>run(load);
  el('payForm').onsubmit=e=>{e.preventDefault();run(async()=>{
    if(!el('expert').value)throw new Error('請先建立專家');
    await api('/api/admin/payroll/'+el('expert').value,{method:'PUT',body:JSON.stringify({month:el('month').value,pay_type:el('payType').value,rate:Number(el('rate').value),lessons:el('payType').value==='lesson'?Number(el('lessons').value):0})});await load();
  });};
  for(const [id,action] of [['clockIn','in'],['clockOut','out']]) el(id).onclick=()=>run(async()=>{await api('/api/expert/attendance/'+action,{method:'POST',body:'{}'});await load();});
  run(async()=>{const me=await api('/api/me');role=me.role;if(!['admin','expert'].includes(role)){location.href='auth.html';return;}el('back').href=role==='admin'?'admin_dashboard.html':'expert_dashboard.html';el(role==='admin'?'settings':'punch').classList.remove('hidden');await load();});
})();
