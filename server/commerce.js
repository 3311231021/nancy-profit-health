// 課程購買、綠界付款、QR Code 核銷、電子發票與銷售統計
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");
const db = require("./database");
const ecpay = require("./ecpay");

const COURSE_TYPES = ["session_pack", "event"];
const INVOICE_TYPES = ["member", "mobile", "donation", "company"];
const QR_TTL_SECONDS = 600;

function safeCode(err) {
  return /^[A-Z0-9_]{1,40}$/.test(err?.code || "") ? err.code : undefined;
}

function fail(res, err, label) {
  console.error(label, { code: safeCode(err) });
  res.status(500).json({ message: "資料庫錯誤，請稍後再試" });
}

async function tx(fn) {
  const client = await (await db.pool()).connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { console.error("Rollback failed"); }
    throw err;
  } finally {
    client.release();
  }
}

function baseUrl(req) {
  if (process.env.SITE_BASE_URL) return process.env.SITE_BASE_URL.replace(/\/$/, "");
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  return (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http://" : "https://") + host;
}

function intOrNull(v, min, max) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
}

module.exports = function commerce(app, { auth, requireRole, secret }) {
  const requireStaff = (req, res, next) =>
    ["admin", "expert"].includes(req.user.role) ? next() : res.status(403).json({ message: "只有管理員或專家可以核銷" });

  // ================= 付款成功處理（綠界通知與主動查詢共用） =================
  async function markPaid(tradeNo, { amount, tradeNoEcpay, paymentType, rtnMsg }) {
    const paid = await tx(async (c) => {
      const order = (await c.query(
        `UPDATE orders SET status='paid', ecpay_trade_no=$2, payment_type=$3, rtn_msg=$4, paid_at=CURRENT_TIMESTAMP
         WHERE merchant_trade_no=$1 AND status<>'paid' AND amount=$5
         RETURNING id, user_id, course_id, sessions, amount`,
        [tradeNo, tradeNoEcpay || null, paymentType || null, rtnMsg || null, amount]
      )).rows[0];
      if (!order) return null;
      const course = (await c.query("SELECT valid_days FROM courses WHERE id=$1", [order.course_id])).rows[0];
      await c.query(
        `INSERT INTO enrollments (order_id, user_id, course_id, total_sessions, remaining_sessions, expires_at)
         VALUES ($1,$2,$3,$4,$4, CASE WHEN $5::int IS NULL THEN NULL ELSE CURRENT_TIMESTAMP + ($5::int * INTERVAL '1 day') END)
         ON CONFLICT (order_id) DO NOTHING`,
        [order.id, order.user_id, order.course_id, order.sessions, course?.valid_days ?? null]
      );
      await c.query("INSERT INTO invoices (order_id, amount) VALUES ($1,$2) ON CONFLICT (order_id) DO NOTHING", [order.id, order.amount]);
      return order;
    });
    if (paid) await issueInvoiceForOrder(paid.id);
    return paid;
  }

  async function issueInvoiceForOrder(orderId) {
    const row = (await db.query(
      `SELECT o.*, u.username, u.email, c.course_type, i.id AS invoice_id, i.status AS invoice_status, i.attempts
       FROM orders o JOIN users u ON u.id=o.user_id JOIN courses c ON c.id=o.course_id
       JOIN invoices i ON i.order_id=o.id WHERE o.id=? AND o.status='paid'`,
      [orderId]
    )).rows[0];
    if (!row || ["issued", "void"].includes(row.invoice_status)) return row;
    const relateNumber = row.attempts === 0 ? row.merchant_trade_no : `${row.merchant_trade_no}R${row.attempts}`;
    await db.query("UPDATE invoices SET attempts=attempts+1, relate_number=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [relateNumber, row.invoice_id]);
    try {
      if (!ecpay.invoiceConfigured()) throw new Error("尚未設定電子發票特店資料");
      const r = await ecpay.issueInvoice({
        relateNumber,
        amount: row.amount,
        itemName: row.item_name,
        itemWord: row.course_type === "event" ? "張" : "堂",
        customerName: row.username,
        customerEmail: row.email,
        invoice_type: row.invoice_type,
        carrier_num: row.carrier_num,
        love_code: row.love_code,
        company_tax_id: row.company_tax_id,
        company_name: row.company_name,
        company_address: row.company_address,
      });
      await db.query(
        "UPDATE invoices SET status='issued', invoice_no=?, invoice_date=?, random_number=?, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        [r.invoiceNo, r.invoiceDate, r.randomNumber, row.invoice_id]
      );
    } catch (err) {
      console.error("Invoice issue failed", { order: orderId });
      await db.query("UPDATE invoices SET status='failed', error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", [String(err.message || err).slice(0, 300), row.invoice_id]);
    }
    return row;
  }

  async function syncOrder(order) {
    if (order.status !== "pending") return order.status;
    const r = await ecpay.queryTrade(order.merchant_trade_no);
    if (String(r.TradeStatus) === "1") {
      await markPaid(order.merchant_trade_no, {
        amount: Number(r.TradeAmt), tradeNoEcpay: r.TradeNo, paymentType: r.PaymentType, rtnMsg: "查詢確認已付款",
      });
      return "paid";
    }
    return "pending";
  }

  // ================= 綠界付款結果通知（ReturnURL，伺服器對伺服器） =================
  app.post("/api/ecpay/notify", async (req, res) => {
    const p = req.body || {};
    res.type("text/plain");
    if (!ecpay.verifyCheckMac(p)) {
      console.error("ECPay notify CheckMacValue mismatch");
      return res.status(400).send("0|CheckMacValue Error");
    }
    try {
      if (String(p.SimulatePaid) === "1") {
        // 綠界後台「模擬付款」：依綠界規範不得變更訂單狀態，只記錄通知已送達
        await db.query("UPDATE orders SET simulated=TRUE, rtn_msg=? WHERE merchant_trade_no=? AND status<>'paid'", ["收到綠界模擬付款通知", p.MerchantTradeNo]);
      } else if (String(p.RtnCode) === "1") {
        const ok = await markPaid(p.MerchantTradeNo, {
          amount: Number(p.TradeAmt), tradeNoEcpay: p.TradeNo, paymentType: p.PaymentType, rtnMsg: p.RtnMsg,
        });
        if (!ok) console.error("ECPay notify ignored (already paid or amount mismatch)");
      } else {
        await db.query("UPDATE orders SET status='failed', rtn_msg=? WHERE merchant_trade_no=? AND status='pending'", [String(p.RtnMsg || "付款失敗").slice(0, 200), p.MerchantTradeNo]);
      }
      res.send("1|OK");
    } catch (err) {
      console.error("ECPay notify failed", { code: safeCode(err) });
      res.status(500).send("0|Error");
    }
  });

  app.get("/api/payment/config", (req, res) => res.json({ test_mode: !ecpay.production }));

  // ================= 課程（學員瀏覽） =================
  app.get("/api/courses", auth, async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT c.id, c.title, c.description, c.course_type, c.price, c.sessions, c.event_at, c.location,
                c.capacity, c.valid_days, u.username AS expert_name, ep.title AS expert_title,
                (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) AS sold
         FROM courses c
         LEFT JOIN users u ON u.id=c.expert_user_id
         LEFT JOIN expert_profiles ep ON ep.user_id=c.expert_user_id
         WHERE c.status='active'
         ORDER BY c.course_type, c.event_at NULLS LAST, c.id DESC`
      );
      res.json(rows);
    } catch (err) { fail(res, err, "List courses failed"); }
  });

  // ================= 學員：建立訂單並取得綠界付款表單 =================
  app.post("/api/orders", auth, requireRole("user"), async (req, res) => {
    const b = req.body || {};
    const courseId = Number(b.course_id);
    const invoiceType = INVOICE_TYPES.includes(b.invoice_type) ? b.invoice_type : "member";
    const carrier = String(b.carrier_num || "").trim().toUpperCase();
    const loveCode = String(b.love_code || "").trim();
    const taxId = String(b.company_tax_id || "").trim();
    const companyName = String(b.company_name || "").trim();
    const companyAddr = String(b.company_address || "").trim();

    if (!courseId) return res.status(400).json({ message: "請選擇課程" });
    if (invoiceType === "mobile" && !/^\/[0-9A-Z.+-]{7}$/.test(carrier)) return res.status(400).json({ message: "手機條碼格式為「/」加 7 碼英數字" });
    if (invoiceType === "donation" && !/^\d{3,7}$/.test(loveCode)) return res.status(400).json({ message: "捐贈碼為 3 至 7 位數字" });
    if (invoiceType === "company" && (!/^\d{8}$/.test(taxId) || !companyName || !companyAddr)) return res.status(400).json({ message: "公司發票請填寫 8 碼統一編號、公司名稱與地址" });
    if (!ecpay.configured()) return res.status(503).json({ message: "尚未設定綠界金流特店資料" });

    try {
      const course = (await db.query("SELECT * FROM courses WHERE id=? AND status='active'", [courseId])).rows[0];
      if (!course) return res.status(404).json({ message: "課程不存在或已下架" });
      if (course.capacity) {
        const taken = (await db.query(
          `SELECT (SELECT COUNT(*) FROM enrollments WHERE course_id=?) +
                  (SELECT COUNT(*) FROM orders WHERE course_id=? AND status='pending' AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 minutes') AS n`,
          [courseId, courseId]
        )).rows[0].n;
        if (taken >= course.capacity) return res.status(409).json({ message: "名額已滿" });
      }
      const tradeNo = ecpay.newTradeNo();
      const itemName = course.course_type === "event" ? `${course.title} 入場券` : `${course.title}（${course.sessions} 堂）`;
      const order = (await db.query(
        `INSERT INTO orders (merchant_trade_no, user_id, course_id, item_name, sessions, amount, invoice_type, carrier_num, love_code, company_tax_id, company_name, company_address)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [tradeNo, req.user.id, courseId, itemName, course.sessions, course.price, invoiceType,
          invoiceType === "mobile" ? carrier : null, invoiceType === "donation" ? loveCode : null,
          invoiceType === "company" ? taxId : null, invoiceType === "company" ? companyName : null, invoiceType === "company" ? companyAddr : null]
      )).rows[0];
      const base = baseUrl(req);
      res.json({
        order_id: order.id,
        merchant_trade_no: tradeNo,
        test_mode: !ecpay.production,
        checkout: ecpay.buildCheckout({
          tradeNo, amount: course.price, itemName, tradeDesc: "ProFit Health 課程購買",
          returnUrl: `${base}/api/ecpay/notify`,
          clientBackUrl: `${base}/my_courses.html?order=${tradeNo}`,
        }),
      });
    } catch (err) { fail(res, err, "Create order failed"); }
  });

  app.get("/api/my/orders", auth, async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT o.id, o.merchant_trade_no, o.item_name, o.amount, o.status, o.invoice_type, o.paid_at, o.created_at, o.rtn_msg, o.simulated,
                i.status AS invoice_status, i.invoice_no, i.invoice_date, i.random_number
         FROM orders o LEFT JOIN invoices i ON i.order_id=o.id
         WHERE o.user_id=? ORDER BY o.created_at DESC, o.id DESC LIMIT 100`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) { fail(res, err, "List my orders failed"); }
  });

  app.post("/api/my/orders/:id/sync", auth, async (req, res) => {
    try {
      const order = (await db.query("SELECT * FROM orders WHERE id=? AND user_id=?", [Number(req.params.id), req.user.id])).rows[0];
      if (!order) return res.status(404).json({ message: "找不到訂單" });
      res.json({ status: await syncOrder(order) });
    } catch (err) {
      console.error("Sync order failed", { code: safeCode(err) });
      res.status(502).json({ message: "暫時無法向綠界查詢付款狀態，請稍後再試" });
    }
  });

  // ================= 學員：我的課程票券 =================
  app.get("/api/my/enrollments", auth, async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT e.id, e.total_sessions, e.remaining_sessions, e.expires_at, e.created_at,
                c.title, c.course_type, c.event_at, c.location, u.username AS expert_name,
                (e.expires_at IS NOT NULL AND e.expires_at < CURRENT_TIMESTAMP) AS expired,
                COALESCE((SELECT json_agg(json_build_object('created_at', r.created_at, 'sessions_used', r.sessions_used, 'by', s.username) ORDER BY r.created_at DESC)
                          FROM redemptions r JOIN users s ON s.id=r.redeemed_by
                          WHERE r.enrollment_id=e.id AND r.status='valid'), '[]') AS history
         FROM enrollments e JOIN courses c ON c.id=e.course_id LEFT JOIN users u ON u.id=c.expert_user_id
         WHERE e.user_id=? ORDER BY (e.remaining_sessions > 0) DESC, e.created_at DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) { fail(res, err, "List enrollments failed"); }
  });

  // 動態 QR Code：10 分鐘內有效、每個只能核銷一次，避免截圖重複使用
  app.get("/api/my/enrollments/:id/qr", auth, async (req, res) => {
    try {
      const e = (await db.query(
        "SELECT id, remaining_sessions, expires_at FROM enrollments WHERE id=? AND user_id=?",
        [Number(req.params.id), req.user.id]
      )).rows[0];
      if (!e) return res.status(404).json({ message: "找不到票券" });
      if (e.remaining_sessions < 1) return res.status(400).json({ message: "堂數已用完" });
      if (e.expires_at && new Date(e.expires_at) < new Date()) return res.status(400).json({ message: "票券已過期" });
      const code = jwt.sign({ typ: "pf-pass", e: e.id, n: crypto.randomBytes(9).toString("base64url") }, secret, { expiresIn: QR_TTL_SECONDS });
      const svg = await QRCode.toString(code, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#1d4634", light: "#fffefa" } });
      res.json({ code, svg, expires_in: QR_TTL_SECONDS, remaining_sessions: e.remaining_sessions });
    } catch (err) { fail(res, err, "Create QR failed"); }
  });

  // ================= 核銷（管理員／專家掃描） =================
  function readPass(code) {
    try {
      const p = jwt.verify(String(code || "").trim(), secret);
      if (p.typ !== "pf-pass" || !p.e || !p.n) return null;
      return p;
    } catch { return null; }
  }

  async function loadPass(c, enrollmentId, lock) {
    return (await c.query(
      `SELECT e.id, e.user_id, e.course_id, e.total_sessions, e.remaining_sessions, e.expires_at,
              c.title, c.course_type, c.expert_user_id, c.event_at, u.username AS student_name, u.email AS student_email
       FROM enrollments e JOIN courses c ON c.id=e.course_id JOIN users u ON u.id=e.user_id
       WHERE e.id=$1 ${lock ? "FOR UPDATE OF e" : ""}`,
      [enrollmentId]
    )).rows[0];
  }

  function passProblem(req, pass) {
    if (!pass) return [404, "找不到票券"];
    if (req.user.role === "expert" && pass.expert_user_id !== req.user.id) return [403, "這不是你負責的課程，無法核銷"];
    if (pass.expires_at && new Date(pass.expires_at) < new Date()) return [400, "票券已過期"];
    if (pass.remaining_sessions < 1) return [400, pass.course_type === "event" ? "此入場券已使用" : "堂數已用完"];
    return null;
  }

  const passView = (p) => ({
    enrollment_id: p.id, student_name: p.student_name, student_email: p.student_email, title: p.title,
    course_type: p.course_type, event_at: p.event_at, total_sessions: p.total_sessions, remaining_sessions: p.remaining_sessions,
  });

  app.post("/api/checkin/preview", auth, requireStaff, async (req, res) => {
    const qr = readPass(req.body?.code);
    if (!qr) return res.status(400).json({ message: "QR Code 無效或已逾時，請學員重新整理 QR Code" });
    try {
      const pass = await loadPass(db, qr.e, false);
      const problem = passProblem(req, pass);
      if (problem) return res.status(problem[0]).json({ message: problem[1], pass: pass ? passView(pass) : null });
      const used = (await db.query("SELECT 1 FROM redemptions WHERE qr_nonce=?", [qr.n])).rows[0];
      if (used) return res.status(409).json({ message: "此 QR Code 已核銷過，請學員重新整理後再掃描", pass: passView(pass) });
      res.json({ pass: passView(pass) });
    } catch (err) { fail(res, err, "Checkin preview failed"); }
  });

  app.post("/api/checkin", auth, requireStaff, async (req, res) => {
    const qr = readPass(req.body?.code);
    if (!qr) return res.status(400).json({ message: "QR Code 無效或已逾時，請學員重新整理 QR Code" });
    try {
      const result = await tx(async (c) => {
        const pass = await loadPass(c, qr.e, true);
        const problem = passProblem(req, pass);
        if (problem) return { problem };
        const ins = await c.query(
          `INSERT INTO redemptions (enrollment_id, user_id, course_id, redeemed_by, sessions_used, qr_nonce)
           VALUES ($1,$2,$3,$4,1,$5) ON CONFLICT (qr_nonce) DO NOTHING RETURNING id`,
          [pass.id, pass.user_id, pass.course_id, req.user.id, qr.n]
        );
        if (!ins.rowCount) return { problem: [409, "此 QR Code 已核銷過，請學員重新整理後再掃描"] };
        await c.query("UPDATE enrollments SET remaining_sessions=remaining_sessions-1 WHERE id=$1", [pass.id]);
        return { pass: { ...pass, remaining_sessions: pass.remaining_sessions - 1 } };
      });
      if (result.problem) return res.status(result.problem[0]).json({ message: result.problem[1] });
      res.json({ message: result.pass.course_type === "event" ? "入場成功" : "已扣除 1 堂", pass: passView(result.pass) });
    } catch (err) { fail(res, err, "Checkin failed"); }
  });

  app.get("/api/checkin/recent", auth, requireStaff, async (req, res) => {
    const mine = req.user.role === "expert";
    try {
      const { rows } = await db.query(
        `SELECT r.id, r.created_at, r.sessions_used, r.status, c.title, c.course_type, u.username AS student_name,
                s.username AS staff_name, e.remaining_sessions, e.total_sessions
         FROM redemptions r JOIN courses c ON c.id=r.course_id JOIN users u ON u.id=r.user_id
         JOIN users s ON s.id=r.redeemed_by JOIN enrollments e ON e.id=r.enrollment_id
         ${mine ? "WHERE c.expert_user_id=?" : ""}
         ORDER BY r.created_at DESC, r.id DESC LIMIT 50`,
        mine ? [req.user.id] : []
      );
      res.json(rows);
    } catch (err) { fail(res, err, "Recent checkins failed"); }
  });

  // ================= 管理員：課程上架 =================
  function readCourse(b) {
    const course_type = COURSE_TYPES.includes(b.course_type) ? b.course_type : null;
    const title = String(b.title || "").trim();
    const price = intOrNull(b.price, 1, 1000000);
    const sessions = intOrNull(b.sessions ?? 1, 1, 500);
    const capacity = intOrNull(b.capacity, 1, 100000);
    const valid_days = intOrNull(b.valid_days, 1, 3650);
    const expert_user_id = b.expert_user_id ? Number(b.expert_user_id) : null;
    const event_at = b.event_at ? new Date(b.event_at) : null;
    const status = b.status === "archived" ? "archived" : "active";
    if (!title || title.length > 100) return { error: "請填寫課程名稱（100 字內）" };
    if (!course_type) return { error: "請選擇課程類型" };
    if (!price) return { error: "價格必須是 1 以上的整數" };
    if (!sessions) return { error: "堂數必須是 1 至 500 的整數" };
    if (Number.isNaN(capacity) || Number.isNaN(valid_days)) return { error: "名額與有效天數必須是正整數" };
    if (event_at && Number.isNaN(event_at.getTime())) return { error: "活動時間格式不正確" };
    return {
      course: {
        title, description: String(b.description || "").trim().slice(0, 1000), course_type, price, sessions,
        expert_user_id, event_at: event_at ? event_at.toISOString() : null,
        location: String(b.location || "").trim().slice(0, 200) || null, capacity, valid_days, status,
      },
    };
  }

  async function checkExpert(id) {
    if (!id) return true;
    const u = (await db.query("SELECT role, COALESCE(status,'active') AS status FROM users WHERE id=?", [id])).rows[0];
    return u && u.role === "expert" && u.status === "active";
  }

  app.get("/api/admin/courses", auth, requireRole("admin"), async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT c.*, u.username AS expert_name,
                (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) AS sold
         FROM courses c LEFT JOIN users u ON u.id=c.expert_user_id
         ORDER BY (c.status='active') DESC, c.id DESC`
      );
      res.json(rows);
    } catch (err) { fail(res, err, "Admin list courses failed"); }
  });

  app.post("/api/admin/courses", auth, requireRole("admin"), async (req, res) => {
    const { course: c, error } = readCourse(req.body || {});
    if (error) return res.status(400).json({ message: error });
    try {
      if (!(await checkExpert(c.expert_user_id))) return res.status(400).json({ message: "負責專家不存在或已停用" });
      const row = (await db.query(
        `INSERT INTO courses (title, description, course_type, price, sessions, expert_user_id, event_at, location, capacity, valid_days, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [c.title, c.description, c.course_type, c.price, c.sessions, c.expert_user_id, c.event_at, c.location, c.capacity, c.valid_days, c.status]
      )).rows[0];
      res.json({ message: "課程已上架", id: row.id });
    } catch (err) { fail(res, err, "Create course failed"); }
  });

  app.put("/api/admin/courses/:id", auth, requireRole("admin"), async (req, res) => {
    const { course: c, error } = readCourse(req.body || {});
    if (error) return res.status(400).json({ message: error });
    try {
      if (!(await checkExpert(c.expert_user_id))) return res.status(400).json({ message: "負責專家不存在或已停用" });
      const r = await db.query(
        `UPDATE courses SET title=?, description=?, course_type=?, price=?, sessions=?, expert_user_id=?, event_at=?, location=?,
                capacity=?, valid_days=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [c.title, c.description, c.course_type, c.price, c.sessions, c.expert_user_id, c.event_at, c.location, c.capacity, c.valid_days, c.status, Number(req.params.id)]
      );
      if (!r.rowCount) return res.status(404).json({ message: "找不到課程" });
      res.json({ message: c.status === "archived" ? "課程已下架" : "課程已更新" });
    } catch (err) { fail(res, err, "Update course failed"); }
  });

  // ================= 管理員：訂單與發票 =================
  function dateRange(q) {
    const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
    return { from: ok(q.from) ? q.from : null, to: ok(q.to) ? q.to : null };
  }

  app.get("/api/admin/orders", auth, requireRole("admin"), async (req, res) => {
    const { from, to } = dateRange(req.query);
    const status = ["pending", "paid", "failed"].includes(req.query.status) ? req.query.status : null;
    try {
      const { rows } = await db.query(
        `SELECT o.id, o.merchant_trade_no, o.item_name, o.amount, o.status, o.payment_type, o.ecpay_trade_no, o.invoice_type,
                o.company_tax_id, o.paid_at, o.created_at, o.rtn_msg, o.simulated, u.username, u.email, c.title AS course_title,
                i.id AS invoice_id, i.status AS invoice_status, i.invoice_no, i.invoice_date, i.error AS invoice_error
         FROM orders o JOIN users u ON u.id=o.user_id JOIN courses c ON c.id=o.course_id LEFT JOIN invoices i ON i.order_id=o.id
         WHERE ($1::text IS NULL OR o.status=$1)
           AND ($2::date IS NULL OR (COALESCE(o.paid_at,o.created_at) AT TIME ZONE 'Asia/Taipei')::date >= $2::date)
           AND ($3::date IS NULL OR (COALESCE(o.paid_at,o.created_at) AT TIME ZONE 'Asia/Taipei')::date <= $3::date)
         ORDER BY o.created_at DESC, o.id DESC LIMIT 500`,
        [status, from, to]
      );
      res.json(rows);
    } catch (err) { fail(res, err, "Admin list orders failed"); }
  });

  app.post("/api/admin/orders/:id/sync", auth, requireRole("admin"), async (req, res) => {
    try {
      const order = (await db.query("SELECT * FROM orders WHERE id=?", [Number(req.params.id)])).rows[0];
      if (!order) return res.status(404).json({ message: "找不到訂單" });
      res.json({ status: await syncOrder(order) });
    } catch (err) {
      console.error("Admin sync order failed", { code: safeCode(err) });
      res.status(502).json({ message: "暫時無法向綠界查詢付款狀態" });
    }
  });

  app.post("/api/admin/orders/:id/invoice", auth, requireRole("admin"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      await issueInvoiceForOrder(id);
      const inv = (await db.query("SELECT status, invoice_no, error FROM invoices WHERE order_id=?", [id])).rows[0];
      if (!inv) return res.status(404).json({ message: "此訂單尚未付款，無法開立發票" });
      if (inv.status !== "issued") return res.status(502).json({ message: inv.error || "發票開立失敗" });
      res.json({ message: `發票已開立：${inv.invoice_no}` });
    } catch (err) { fail(res, err, "Retry invoice failed"); }
  });

  app.post("/api/admin/invoices/:id/void", auth, requireRole("admin"), async (req, res) => {
    try {
      const inv = (await db.query("SELECT * FROM invoices WHERE id=?", [Number(req.params.id)])).rows[0];
      if (!inv || inv.status !== "issued") return res.status(400).json({ message: "只有已開立的發票可以作廢" });
      await ecpay.voidInvoice({ invoiceNo: inv.invoice_no, invoiceDate: inv.invoice_date, reason: req.body?.reason });
      await db.query("UPDATE invoices SET status='void', updated_at=CURRENT_TIMESTAMP WHERE id=?", [inv.id]);
      res.json({ message: "發票已作廢" });
    } catch (err) {
      console.error("Void invoice failed", { code: safeCode(err) });
      res.status(502).json({ message: String(err.message || "發票作廢失敗").slice(0, 200) });
    }
  });

  // ---------------- 發票字軌（資料存在綠界，本站只做查詢與設定） ----------------
  function wordFail(res, err, label) {
    console.error(label, { code: safeCode(err) });
    res.status(502).json({ message: String(err.message || label).slice(0, 200) });
  }

  app.get("/api/admin/invoice-words", auth, requireRole("admin"), async (req, res) => {
    const current = Number(ecpay.rocYear());
    const year = Number(req.query.year || current);
    const term = intOrNull(req.query.term ?? 0, 0, 6);
    const useStatus = intOrNull(req.query.use_status ?? 0, 0, 6);
    if (!Number.isInteger(year) || year < current - 1 || year > current + 1) return res.status(400).json({ message: "只能查詢去年、今年或明年的字軌" });
    if (Number.isNaN(term) || Number.isNaN(useStatus)) return res.status(400).json({ message: "查詢條件不正確" });
    try {
      const [words, gov] = await Promise.all([
        ecpay.listInvoiceWords({ year: String(year), term: term || 0, useStatus: useStatus || 0 }),
        ecpay.listGovInvoiceWords(String(year)),
      ]);
      res.json({
        test_mode: !ecpay.production,
        current_year: current,
        year,
        words: words.words,
        words_message: words.message,
        gov: gov.words,
        gov_message: gov.message,
      });
    } catch (err) { wordFail(res, err, "查詢字軌失敗"); }
  });

  app.post("/api/admin/invoice-words", auth, requireRole("admin"), async (req, res) => {
    const b = req.body || {};
    const current = Number(ecpay.rocYear());
    const year = Number(b.year);
    const term = Number(b.term);
    const header = String(b.header || "").trim().toUpperCase();
    const start = String(b.start || "").trim();
    const end = String(b.end || "").trim();
    const invType = b.inv_type === "08" ? "08" : "07";
    if (year !== current && year !== current + 1) return res.status(400).json({ message: "只能設定今年或明年的字軌" });
    if (!Number.isInteger(term) || term < 1 || term > 6) return res.status(400).json({ message: "請選擇期別" });
    const currentTerm = Math.ceil(Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", month: "numeric" }).format(new Date())) / 2);
    if (year === current && term < currentTerm) return res.status(400).json({ message: "不能設定已經過去的期別" });
    if (!/^[A-Z]{2}$/.test(header)) return res.status(400).json({ message: "字軌須為 2 個英文字母" });
    if (!/^\d{6}(00|50)$/.test(start)) return res.status(400).json({ message: "起始號碼須為 8 碼數字，且結尾為 00 或 50" });
    if (!/^\d{6}(49|99)$/.test(end)) return res.status(400).json({ message: "結束號碼須為 8 碼數字，且結尾為 49 或 99" });
    if (Number(end) <= Number(start)) return res.status(400).json({ message: "結束號碼必須大於起始號碼" });
    try {
      const r = await ecpay.addInvoiceWord({ year: String(year), term, invType, header, start, end });
      res.json({ message: "字軌已新增，請按「啟用」後才會用來開立發票", track_id: r.trackId });
    } catch (err) { wordFail(res, err, "字軌新增失敗"); }
  });

  app.post("/api/admin/invoice-words/:trackId/status", auth, requireRole("admin"), async (req, res) => {
    const trackId = String(req.params.trackId);
    const status = Number(req.body?.status);
    if (!/^[A-Za-z0-9]{1,10}$/.test(trackId)) return res.status(400).json({ message: "字軌編號不正確" });
    if (![0, 1, 2].includes(status)) return res.status(400).json({ message: "狀態不正確" });
    try {
      await ecpay.updateInvoiceWordStatus(trackId, status);
      res.json({ message: { 0: "字軌已停用", 1: "字軌已暫停", 2: "字軌已啟用" }[status] });
    } catch (err) { wordFail(res, err, "字軌狀態設定失敗"); }
  });

  app.post("/api/admin/redemptions/:id/revoke", auth, requireRole("admin"), async (req, res) => {
    try {
      const done = await tx(async (c) => {
        const r = (await c.query("UPDATE redemptions SET status='revoked' WHERE id=$1 AND status='valid' RETURNING enrollment_id, sessions_used", [Number(req.params.id)])).rows[0];
        if (!r) return false;
        await c.query("UPDATE enrollments SET remaining_sessions=LEAST(total_sessions, remaining_sessions+$2) WHERE id=$1", [r.enrollment_id, r.sessions_used]);
        return true;
      });
      if (!done) return res.status(404).json({ message: "找不到核銷紀錄或已撤銷" });
      res.json({ message: "已撤銷核銷並退回堂數" });
    } catch (err) { fail(res, err, "Revoke redemption failed"); }
  });

  // ================= 管理員：銷貨收入與課程使用統計 =================
  app.get("/api/admin/stats", auth, requireRole("admin"), async (req, res) => {
    const { from, to } = dateRange(req.query);
    const paidIn = `o.status='paid'
      AND ($1::date IS NULL OR (o.paid_at AT TIME ZONE 'Asia/Taipei')::date >= $1::date)
      AND ($2::date IS NULL OR (o.paid_at AT TIME ZONE 'Asia/Taipei')::date <= $2::date)`;
    try {
      const [totals, monthly, byCourse, invoiceStats, checkins] = await Promise.all([
        db.query(
          `SELECT COUNT(*) AS orders, COALESCE(SUM(o.amount),0) AS revenue,
                  COALESCE(SUM(ROUND(o.amount/1.05)),0)::bigint AS net_sales, COUNT(DISTINCT o.user_id) AS buyers
           FROM orders o WHERE ${paidIn}`, [from, to]),
        db.query(
          `SELECT TO_CHAR(o.paid_at AT TIME ZONE 'Asia/Taipei','YYYY-MM') AS month, COUNT(*) AS orders, SUM(o.amount) AS revenue,
                  SUM(ROUND(o.amount/1.05))::bigint AS net_sales
           FROM orders o WHERE o.status='paid' AND o.paid_at >= date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei') - INTERVAL '11 months'
           GROUP BY 1 ORDER BY 1`),
        db.query(
          `SELECT c.id, c.title, c.course_type, c.price, c.sessions, c.status, c.capacity, u.username AS expert_name,
                  COALESCE(s.orders,0) AS orders, COALESCE(s.revenue,0) AS revenue,
                  COALESCE(e.sold,0) AS sold, COALESCE(e.sessions_sold,0) AS sessions_sold,
                  COALESCE(e.sessions_left,0) AS sessions_left, COALESCE(e.active_students,0) AS active_students,
                  COALESCE(r.checkins_30d,0) AS checkins_30d
           FROM courses c LEFT JOIN users u ON u.id=c.expert_user_id
           LEFT JOIN (SELECT o.course_id, COUNT(*) AS orders, SUM(o.amount) AS revenue FROM orders o WHERE ${paidIn} GROUP BY o.course_id) s ON s.course_id=c.id
           LEFT JOIN (SELECT course_id, COUNT(*) AS sold, SUM(total_sessions) AS sessions_sold, SUM(remaining_sessions) AS sessions_left,
                             COUNT(DISTINCT user_id) FILTER (WHERE remaining_sessions>0 AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)) AS active_students
                      FROM enrollments GROUP BY course_id) e ON e.course_id=c.id
           LEFT JOIN (SELECT course_id, COUNT(*) AS checkins_30d FROM redemptions
                      WHERE status='valid' AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 days' GROUP BY course_id) r ON r.course_id=c.id
           ORDER BY revenue DESC, c.id DESC`, [from, to]),
        db.query(
          `SELECT i.status, COUNT(*) AS count, COALESCE(SUM(i.amount),0) AS amount
           FROM invoices i JOIN orders o ON o.id=i.order_id WHERE ${paidIn} GROUP BY i.status`, [from, to]),
        db.query(
          `SELECT COUNT(*) FILTER (WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '30 days') AS last_30d,
                  COUNT(*) AS total FROM redemptions WHERE status='valid'`),
      ]);
      const t = totals.rows[0];
      res.json({
        range: { from, to },
        totals: { ...t, tax: t.revenue - t.net_sales },
        monthly: monthly.rows,
        by_course: byCourse.rows,
        invoices: invoiceStats.rows,
        checkins: checkins.rows[0],
        test_mode: !ecpay.production,
      });
    } catch (err) { fail(res, err, "Admin stats failed"); }
  });
};
