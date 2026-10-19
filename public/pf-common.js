// 課程購買、核銷與銷售頁面共用的小工具
const PF = (() => {
  const token = () => localStorage.getItem("token");

  async function api(path, method = "GET", body = null) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
      body: body ? JSON.stringify(body) : null,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || (res.status === 403 && /token|帳號/.test(data.message || ""))) {
      localStorage.removeItem("token");
      location.href = "auth.html";
      throw new Error(data.message || "請重新登入");
    }
    if (!res.ok) {
      const err = new Error(data.message || `操作失敗（${res.status}）`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // 確認登入身分；roles 不符時導回各自的首頁
  async function guard(roles) {
    if (!token()) { location.href = "auth.html"; throw new Error("未登入"); }
    const me = await api("/api/me");
    if (!roles.includes(me.role)) {
      location.href = me.role === "admin" ? "admin_dashboard.html" : me.role === "expert" ? "expert_dashboard.html" : "dashboard.html";
      throw new Error("權限不足");
    }
    return me;
  }

  function logout() {
    localStorage.removeItem("token");
    location.href = "auth.html";
  }

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => "NT$ " + Number(n || 0).toLocaleString("zh-TW");
  const num = (n) => Number(n || 0).toLocaleString("zh-TW");
  const dt = (v) => { if (!v) return "-"; const d = new Date(v); return isNaN(d) ? "-" : d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); };
  const day = (v) => { if (!v) return "-"; const d = new Date(v); return isNaN(d) ? "-" : d.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" }); };

  const ORDER_STATUS = { pending: "待付款", paid: "已付款", failed: "付款失敗" };
  const INVOICE_STATUS = { pending: "開立中", issued: "已開立", failed: "開立失敗", void: "已作廢" };
  const INVOICE_TYPE = { member: "會員載具", mobile: "手機條碼", donation: "捐贈", company: "公司統編" };
  const COURSE_TYPE = { session_pack: "堂數課程", event: "講座／活動" };

  // 送出綠界付款表單（瀏覽器直接 POST 到綠界）
  function submitCheckout({ action, fields }) {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = action;
    for (const [k, v] of Object.entries(fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = k;
      input.value = v;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  }

  return { api, guard, logout, esc, money, num, dt, day, ORDER_STATUS, INVOICE_STATUS, INVOICE_TYPE, COURSE_TYPE, submitCheckout };
})();
