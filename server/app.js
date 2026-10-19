// backend/index.js
const express = require("express");
const db = require("./database");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const path = require("path");

const app = express();
// serverless-http supplies a completed request with a raw Buffer body.
// Parse that body before Express 5's JSON parser skips the completed stream.
app.use((req, res, next) => {
  if (!req.apiGateway || !Buffer.isBuffer(req.body)) return next();
  const raw = req.body;
  if (raw.length > 100 * 1024) return res.status(413).json({message: "資料過大"});
  if (raw.length === 0) { req.body = {}; return next(); }
  // 綠界付款通知以表單格式（x-www-form-urlencoded）送出
  if (req.path.startsWith("/api/ecpay/") && /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.get("content-type") || "")) {
    req.body = Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
    return next();
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.get("content-type") || "")) {
    return res.status(415).json({message: "請使用 JSON 格式送出資料"});
  }
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JSON body");
    req.body = parsed;
    next();
  } catch { res.status(400).json({message: "JSON 資料格式不正確"}); }
});
app.use(express.json());
app.use("/api/ecpay", express.urlencoded({ extended: false }));


// ✅ 避免前端 / API 被快取
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ================= JWT 設定 =================
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) throw new Error("請設定至少 32 字元的 JWT_SECRET");
require("./setup")(app);

// ================= 小工具 =================
function dbAll(sql, params, res) {
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ message: "資料庫錯誤", error: String(err) });
    res.json(rows || []);
  });
}

function dbGet(sql, params, res, fallback = null) {
  db.get(sql, params, (err, row) => {
    if (err) return res.status(500).json({ message: "資料庫錯誤", error: String(err) });
    res.json(row ?? fallback);
  });
}

// ================= JWT Middleware =================
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ message: "尚未登入（缺少 token）" });

  jwt.verify(token, SECRET, (err, payload) => {
    if (err) return res.status(403).json({ message: "token 無效或過期" });
    db.get("SELECT id, role, status FROM users WHERE id = ?", [payload.id], (dbErr, account) => {
      if (dbErr) return res.status(503).json({message:"暫時無法讀取帳號"});
      if (!account || account.status !== "active") return res.status(403).json({message:"帳號不存在或已停用"});
      req.user = {id:account.id, role:account.role};
      next();
    });
  });
}

// ================= RBAC + 狀態檢查 =================
function requireRole(role) {
  return (req, res, next) => {
    db.get(
      `SELECT role, COALESCE(status,'active') AS status FROM users WHERE id = ?`,
      [req.user.id],
      (err, row) => {
        if (err) return res.status(500).json({ message: "資料庫錯誤", error: String(err) });
        if (!row) return res.status(401).json({ message: "使用者不存在" });

        if (String(row.status).toLowerCase() !== "active") {
          return res.status(403).json({ message: "帳號已停用" });
        }

        if (row.role !== role) return res.status(403).json({ message: "Forbidden" });
        next();
      }
    );
  };
}

// 專家只能看自己被指派的 client（且指派狀態要 active）
function requireAssignedClient(req, res, next) {
  const clientId = Number(req.params.clientId);
  if (!clientId) return res.status(400).json({ message: "clientId 不正確" });

  db.get(
    `SELECT 1
     FROM expert_assignments
     WHERE expert_user_id = ? AND client_user_id = ? AND status = 'active'`,
    [req.user.id, clientId],
    (err, row) => {
      if (err) return res.status(500).json({ message: "資料庫錯誤", error: String(err) });
      if (!row) return res.status(403).json({ message: "Forbidden: not assigned" });
      next();
    }
  );
}

// ================= ✅ 專業類型（固定 4 種） =================
const SPECIALTY_TITLE_MAP = {
  coach: "教練",
  doctor: "醫師",
  pt: "物理治療師",
  at: "運動防護員",
};
function isValidSpecialty(s) {
  return Object.prototype.hasOwnProperty.call(SPECIALTY_TITLE_MAP, s);
}

// ================= API：健康檢查 =================
app.get("/api/ping", (req, res) => res.json({ ok: true }));

// ================= Auth APIs =================
app.post("/api/register", (req, res) => {
  const { email, password, username } = req.body || {};
  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password || typeof username !== "string" || !username.trim()) {
    return res.status(400).json({ message: "缺少 email / password / username" });
  }

  if (String(password).length < 12 || Buffer.byteLength(String(password)) > 72) return res.status(400).json({message:"密碼請使用 12 至 72 個字元"});
  const hash = bcrypt.hashSync(String(password), 10);

  db.run(
    `INSERT INTO users (email, password, username, role, status) VALUES (?,?,?, 'user', 'active')`,
    [String(email).trim().toLowerCase(), hash, String(username).trim()],
    (err) => {
      if (err) {
        if (err.code === "23505" && err.constraint === "users_email_key") {
          return res.status(409).json({ code: "EMAIL_ALREADY_EXISTS", message: "此 Email 已註冊，請切換至登入並使用原本的密碼；重新註冊不會重設密碼。" });
        }
        console.error("Registration unavailable", { code: /^[A-Z0-9_]{1,40}$/.test(err.code || "") ? err.code : undefined });
        return res.status(503).json({ code: "REGISTRATION_UNAVAILABLE", message: "目前無法建立帳號，請聯絡網站管理員檢查資料庫設定；這不代表 Email 已註冊。" });
      }
      res.json({ message: "註冊成功" });
    }
  );
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: "缺少 email / password" });

  db.get(`SELECT * FROM users WHERE email = ?`, [String(email).trim().toLowerCase()], (err, user) => {
    if (err) {
      console.error("Login unavailable", { code: /^[A-Z0-9_]{1,40}$/.test(err.code || "") ? err.code : undefined });
      return res.status(503).json({ code: "LOGIN_UNAVAILABLE", message: "目前無法查詢帳號，請聯絡網站管理員檢查資料庫設定；這不代表密碼錯誤。" });
    }
    if (!user) return res.status(401).json({ message: "帳密錯誤" });

    // ✅ 停用帳號不能登入
    const st = String(user.status || "active").toLowerCase();
    if (st !== "active") {
      return res.status(403).json({ message: "此帳號已停用，請聯絡管理員" });
    }

    const ok = bcrypt.compareSync(String(password), user.password);
    if (!ok) return res.status(401).json({ message: "帳密錯誤" });

    // ✅ token 夾帶 role（前端導頁方便），後端仍以 DB requireRole 為主
    const token = jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: "1d" });
    res.json({ message: "登入成功", token, role: user.role });
  });
});

// ================= 使用者 =================
app.get("/api/me", auth, (req, res) => {
  dbGet(
    `SELECT id, email, username, role, created_at, COALESCE(status,'active') AS status
     FROM users WHERE id = ?`,
    [req.user.id],
    res
  );
});

app.put("/api/me", auth, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ message: "缺少 username" });

  db.run(`UPDATE users SET username = ? WHERE id = ?`, [String(username).trim(), req.user.id], function (err) {
    if (err) return res.status(500).json({ message: "更新失敗", error: String(err) });
    res.json({ message: "更新成功" });
  });
});

// ================= 運動紀錄 =================
function insertActivity(req, res) {
  const { activity_type, duration, steps = 0, heart_rate = 0, speed = 0, calories = 0 } = req.body || {};
  const d = Number(duration);
  if (!d || d <= 0) return res.status(400).json({ message: "duration 必須 > 0" });

  db.run(
    `INSERT INTO activity_records (user_id, activity_type, duration, steps, heart_rate, speed, calories)
     VALUES (?,?,?,?,?,?,?)`,
    [
      req.user.id,
      String(activity_type || ""),
      d,
      Number(steps) || 0,
      Number(heart_rate) || 0,
      Number(speed) || 0,
      Number(calories) || 0,
    ],
    function (err) {
      if (err) return res.status(500).json({ message: "儲存失敗", error: String(err) });
      res.json({ message: "儲存成功", id: this.lastID });
    }
  );
}

function listActivity(req, res) {
  dbAll(
    `SELECT * FROM activity_records
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC`,
    [req.user.id],
    res
  );
}

app.post("/api/activity", auth, insertActivity);
app.get("/api/activity", auth, listActivity);

// 舊版相容
app.post("/api/activity_records", auth, insertActivity);
app.get("/api/activity_records", auth, listActivity);

// ================= 健康紀錄 =================
app.post("/api/health_records", auth, (req, res) => {
  const { height, weight, bmi } = req.body || {};
  const h = Number(height),
    w = Number(weight),
    b = Number(bmi);
  if (!h || !w || !b) return res.status(400).json({ message: "請提供 height / weight / bmi" });

  db.run(
    `INSERT INTO health_records (user_id, height, weight, bmi) VALUES (?,?,?,?)`,
    [req.user.id, h, w, b],
    function (err) {
      if (err) return res.status(500).json({ message: "儲存失敗", error: String(err) });
      res.json({ message: "儲存成功", id: this.lastID });
    }
  );
});

app.get("/api/health_records", auth, (req, res) => {
  dbAll(
    `SELECT * FROM health_records WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    [req.user.id],
    res
  );
});

// dashboard 容錯相容
app.get("/api/health", auth, (req, res) => {
  dbAll(
    `SELECT * FROM health_records WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
    [req.user.id],
    res
  );
});

// ================= 目標設定 =================
app.get("/api/goals", auth, (req, res) => {
  dbGet(
    `SELECT daily_steps, daily_minutes, daily_calories FROM goals WHERE user_id = ?`,
    [req.user.id],
    res,
    { daily_steps: 5000, daily_minutes: 30, daily_calories: 300 }
  );
});

app.put("/api/goals", auth, (req, res) => {
  const { daily_steps = 5000, daily_minutes = 30, daily_calories = 300 } = req.body || {};

  db.run(
    `INSERT INTO goals (user_id, daily_steps, daily_minutes, daily_calories)
     VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       daily_steps = excluded.daily_steps,
       daily_minutes = excluded.daily_minutes,
       daily_calories = excluded.daily_calories`,
    [req.user.id, Number(daily_steps) || 0, Number(daily_minutes) || 0, Number(daily_calories) || 0],
    function (err) {
      if (err) return res.status(500).json({ message: "更新失敗", error: String(err) });
      res.json({ message: "目標已更新" });
    }
  );
});

// ================= 專家：個案清單 =================
app.get("/api/expert/clients", auth, requireRole("expert"), (req, res) => {
  const sql = `
    SELECT
      ea.client_user_id AS client_id,
      u.username,
      u.email,
      ea.status,
      ep.specialty,
      ep.title,
      (
        SELECT MAX(ar.created_at)
        FROM activity_records ar
        WHERE ar.user_id = ea.client_user_id
      ) AS last_activity_at
    FROM expert_assignments ea
    JOIN users u ON u.id = ea.client_user_id
    LEFT JOIN expert_profiles ep ON ep.user_id = ea.expert_user_id
    WHERE ea.expert_user_id = ? AND ea.status = 'active'
    ORDER BY last_activity_at DESC NULLS LAST,
             ea.client_user_id ASC
  `;
  dbAll(sql, [req.user.id], res);
});

// ================= 專家：個案概覽 =================
app.get("/api/expert/clients/:clientId/overview", auth, requireRole("expert"), requireAssignedClient, (req, res) => {
  const clientId = Number(req.params.clientId);

  db.get(
    `SELECT id, email, username, role, created_at, COALESCE(status,'active') AS status
     FROM users WHERE id = ?`,
    [clientId],
    (err, client) => {
      if (err) return res.status(500).json({ message: "資料庫錯誤", error: String(err) });
      if (!client) return res.status(404).json({ message: "找不到個案" });

      db.get(
        `SELECT daily_steps, daily_minutes, daily_calories FROM goals WHERE user_id = ?`,
        [clientId],
        (err2, goals) => {
          if (err2) return res.status(500).json({ message: "資料庫錯誤", error: String(err2) });
          const goalsSafe = goals || { daily_steps: 5000, daily_minutes: 30, daily_calories: 300 };

          db.get(
            `SELECT *
             FROM health_records
             WHERE user_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [clientId],
            (err3, latestHealth) => {
              if (err3) return res.status(500).json({ message: "資料庫錯誤", error: String(err3) });

              db.all(
                `SELECT
                   TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS day,
                   COUNT(*) AS sessions,
                   SUM(duration) AS total_minutes,
                   SUM(steps) AS total_steps,
                   SUM(calories) AS total_calories,
                   AVG(heart_rate) AS avg_heart_rate
                 FROM activity_records
                 WHERE user_id = ?
                   AND created_at >= (CURRENT_TIMESTAMP - INTERVAL '6 days')
                 GROUP BY TO_CHAR(created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD')
                 ORDER BY day DESC`,
                [clientId],
                (err4, last7days) => {
                  if (err4) return res.status(500).json({ message: "資料庫錯誤", error: String(err4) });

                  db.all(
                    `SELECT id, activity_type, duration, steps, heart_rate, speed, calories, created_at, source, title, distance_km
                     FROM activity_records
                     WHERE user_id = ?
                     ORDER BY created_at DESC, id DESC
                     LIMIT 30`,
                    [clientId],
                    (err5, recentActivities) => {
                      if (err5) return res.status(500).json({ message: "資料庫錯誤", error: String(err5) });

                      res.json({
                        client,
                        goals: goalsSafe,
                        latest_health: latestHealth || null,
                        last_7_days: last7days || [],
                        recent_activities: recentActivities || [],
                      });
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});

// ================= 專家：新增 notes（回饋/任務） =================
app.post("/api/expert/clients/:clientId/notes", auth, requireRole("expert"), requireAssignedClient, (req, res) => {
  const clientId = Number(req.params.clientId);
  const {
    note_type, // feedback | task
    content,
    target_date = null,
    target_minutes = null,
    target_steps = null,
    target_calories = null,
  } = req.body || {};

  const nt = String(note_type || "").trim();
  const ct = String(content || "").trim();

  if (!["feedback", "task"].includes(nt)) {
    return res.status(400).json({ message: "note_type 必須是 feedback 或 task" });
  }
  if (!ct) return res.status(400).json({ message: "content 不能為空" });

  db.run(
    `INSERT INTO expert_notes
      (expert_user_id, client_user_id, note_type, content, target_date, target_minutes, target_steps, target_calories)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      req.user.id,
      clientId,
      nt,
      ct,
      target_date ? String(target_date) : null,
      target_minutes === "" ? null : target_minutes == null ? null : Number(target_minutes),
      target_steps === "" ? null : target_steps == null ? null : Number(target_steps),
      target_calories === "" ? null : target_calories == null ? null : Number(target_calories),
    ],
    function (err) {
      if (err) return res.status(500).json({ message: "資料庫錯誤", error: String(err) });
      res.json({ message: "已新增", id: this.lastID });
    }
  );
});

app.get("/api/expert/clients/:clientId/notes", auth, requireRole("expert"), requireAssignedClient, (req, res) => {
  const clientId = Number(req.params.clientId);
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  dbAll(
    `SELECT id, note_type, content, target_date, target_minutes, target_steps, target_calories, created_at
     FROM expert_notes
     WHERE expert_user_id = ? AND client_user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [req.user.id, clientId, limit],
    res
  );
});

// ================= ✅ 學員：看到自己的回饋/任務（含專家名稱） =================
app.get("/api/client/notes", auth, requireRole("user"), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);

  dbAll(
    `SELECT
       n.id,
       n.note_type,
       n.content,
       n.target_date,
       n.target_minutes,
       n.target_steps,
       n.target_calories,
       n.created_at,
       u.username AS expert_name,
       u.email AS expert_email
     FROM expert_notes n
     JOIN users u ON u.id = n.expert_user_id
     WHERE n.client_user_id = ?
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT ?`,
    [req.user.id, limit],
    res
  );
});

// ================= ✅ 學員：我的專家（active 指派） =================
app.get("/api/client/experts", auth, requireRole("user"), (req, res) => {
  dbAll(
    `SELECT ea.expert_user_id, u.username, ep.specialty, ep.title
     FROM expert_assignments ea
     JOIN users u ON u.id = ea.expert_user_id
     LEFT JOIN expert_profiles ep ON ep.user_id = ea.expert_user_id
     WHERE ea.client_user_id = ? AND ea.status = 'active' AND COALESCE(u.status,'active') = 'active'
     ORDER BY ea.created_at ASC, ea.id ASC`,
    [req.user.id],
    res
  );
});

// ================= ✅ 學員：提問（可指定 expert；未指定則找最近 active 指派的 expert） =================
app.post("/api/client/questions", auth, requireRole("user"), (req, res) => {
  const q = String(req.body?.question || "").trim();
  if (!q) return res.status(400).json({ message: "question 不能為空" });
  const chosenExpertId = Number(req.body?.expert_user_id) || null;

  db.get(
    `SELECT expert_user_id
     FROM expert_assignments
     WHERE client_user_id = ? AND status = 'active'${chosenExpertId ? " AND expert_user_id = ?" : ""}
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    chosenExpertId ? [req.user.id, chosenExpertId] : [req.user.id],
    (err, row) => {
      if (!err && chosenExpertId && !row) return res.status(403).json({ message: "只能向指派給你的專家提問" });
      if (err) return res.status(500).json({ message: "資料庫錯誤", error: String(err) });

      const expertId = row ? Number(row.expert_user_id) : null;

      db.run(
        `INSERT INTO client_questions (client_user_id, expert_user_id, question)
         VALUES (?,?,?)`,
        [req.user.id, expertId, q],
        function (e2) {
          if (e2) return res.status(500).json({ message: "資料庫錯誤", error: String(e2) });
          res.json({ message: "已送出提問", id: this.lastID, expert_user_id: expertId });
        }
      );
    }
  );
});

// ================= ✅ 學員：查看自己的問答清單（含專家名稱） =================
app.get("/api/client/questions", auth, requireRole("user"), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  dbAll(
    `SELECT
       q.id,
       q.question,
       q.reply,
       q.status,
       q.created_at,
       q.replied_at,
       u.username AS expert_name
     FROM client_questions q
     LEFT JOIN users u ON u.id = q.expert_user_id
     WHERE q.client_user_id = ?
     ORDER BY q.created_at DESC, q.id DESC
     LIMIT ?`,
    [req.user.id, limit],
    res
  );
});

// ================= ✅ 專家：查看某個案提問清單（允許 expert_user_id NULL） =================
app.get("/api/expert/clients/:clientId/questions", auth, requireRole("expert"), requireAssignedClient, (req, res) => {
  const clientId = Number(req.params.clientId);
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  dbAll(
    `SELECT id, client_user_id, expert_user_id, question, reply, status, created_at, replied_at
     FROM client_questions
     WHERE client_user_id = ?
       AND (expert_user_id = ? OR expert_user_id IS NULL)
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [clientId, req.user.id, limit],
    res
  );
});

// ================= ✅ 專家：回覆提問（若 expert_user_id 為 NULL，補上自己） =================
app.post(
  "/api/expert/clients/:clientId/questions/:qid/reply",
  auth,
  requireRole("expert"),
  requireAssignedClient,
  (req, res) => {
    const clientId = Number(req.params.clientId);
    const qid = Number(req.params.qid);
    const reply = String(req.body?.reply || "").trim();

    if (!qid) return res.status(400).json({ message: "qid 不正確" });
    if (!reply) return res.status(400).json({ message: "reply 不能為空" });

    db.run(
      `UPDATE client_questions
       SET reply = ?,
           status = 'answered',
           replied_at = CURRENT_TIMESTAMP,
           expert_user_id = COALESCE(expert_user_id, ?)
       WHERE id = ? AND client_user_id = ? AND (expert_user_id IS NULL OR expert_user_id = ?)`,
      [reply, req.user.id, qid, clientId, req.user.id],
      function (err) {
        if (err) return res.status(500).json({ message: "資料庫錯誤", error: String(err) });
        if (this.changes === 0) return res.status(404).json({ message: "找不到該提問" });
        res.json({ message: "已回覆" });
      }
    );
  }
);

// ===================================================================
// ========================= ✅ 管理員 APIs ===========================
// ===================================================================

// ✅ 管理員：專家清單（預設只顯示 active；include_inactive=1 顯示停用）
app.get("/api/admin/experts", auth, requireRole("admin"), (req, res) => {
  const includeInactive = String(req.query.include_inactive || "0") === "1";

  const where = includeInactive
    ? `WHERE u.role='expert'`
    : `WHERE u.role='expert' AND COALESCE(u.status,'active')='active'`;

  const sql = `
    SELECT
      u.id AS expert_user_id,
      u.username,
      u.email,
      u.role,
      COALESCE(u.status,'active') AS status,
      ep.specialty,
      ep.title,
      ep.created_at AS profile_created_at
    FROM users u
    LEFT JOIN expert_profiles ep ON ep.user_id = u.id
    ${where}
    ORDER BY u.id ASC
  `;

  dbAll(sql, [], res);
});

// ✅ 管理員：學員清單（預設只顯示 active；include_inactive=1 顯示停用）
app.get("/api/admin/clients", auth, requireRole("admin"), (req, res) => {
  const includeInactive = String(req.query.include_inactive || "0") === "1";

  const where = includeInactive
    ? `WHERE role='user'`
    : `WHERE role='user' AND COALESCE(status,'active')='active'`;

  const sql = `
    SELECT id AS client_user_id, username, email, role, created_at, COALESCE(status,'active') AS status
    FROM users
    ${where}
    ORDER BY id ASC
  `;
  dbAll(sql, [], res);
});

// ✅ 管理員：新增專業人員（四種：coach/doctor/pt/at）
app.post("/api/admin/experts", auth, requireRole("admin"), async (req, res, next) => {
  const { email, password, username, specialty, payroll } = req.body || {};
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || typeof username !== 'string' || !username.trim() || typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72 || !isValidSpecialty(specialty)) {
    return res.status(400).json({message:'請填寫姓名、有效 Email、專業類型與至少 12 字元密碼（最多 72 bytes）'});
  }
  if (payroll && !require('./payroll').validPay(payroll)) return res.status(400).json({message:'請填寫有效計薪方式與金額'});
  let client;
  try {
    const hash = await bcrypt.hash(password, 10);
    client = await (await db.pool()).connect();
    await client.query('BEGIN');
    const user = (await client.query("INSERT INTO users(email,password,username,role,status) VALUES ($1,$2,$3,'expert','active') RETURNING id",[email.trim().toLowerCase(),hash,username.trim()])).rows[0];
    await client.query('INSERT INTO expert_profiles(user_id,specialty,title) VALUES ($1,$2,$3)',[user.id,specialty,SPECIALTY_TITLE_MAP[specialty]]);
    if(payroll) await client.query('INSERT INTO expert_payroll(user_id,month,pay_type,rate,lessons,updated_by) VALUES ($1,$2,$3,$4,0,$5)',[user.id,require('./payroll').currentMonth()+'-01',payroll.pay_type,payroll.rate,req.user.id]);
    await client.query('COMMIT');
    res.json({message:'新增專業人員成功',expert:{expert_user_id:user.id}});
  } catch(error) {
    if(client) await client.query('ROLLBACK');
    if(error.code === '23505') return res.status(409).json({message:'此 Email 已註冊'});
    next(error);
  } finally { client?.release(); }
});

const ASSIGNMENT_STATUSES = ["active", "ended"];

// ✅ 管理員：所有配對清單（專家 ↔ 學員）
app.get("/api/admin/assignments", auth, requireRole("admin"), (req, res) => {
  const sql = `
    SELECT
      ea.id,
      ea.expert_user_id,
      ea.client_user_id,
      ea.status,
      ea.created_at,
      e.username AS expert_name,
      e.email AS expert_email,
      COALESCE(e.status,'active') AS expert_status,
      ep.title,
      c.username AS client_name,
      c.email AS client_email,
      COALESCE(c.status,'active') AS client_status,
      (SELECT COUNT(*) FROM client_questions q
        WHERE q.client_user_id = ea.client_user_id AND q.status = 'open'
          AND (q.expert_user_id = ea.expert_user_id OR q.expert_user_id IS NULL)) AS open_questions,
      (SELECT COUNT(*) FROM expert_notes n
        WHERE n.client_user_id = ea.client_user_id AND n.expert_user_id = ea.expert_user_id AND n.note_type = 'task') AS task_count
    FROM expert_assignments ea
    JOIN users e ON e.id = ea.expert_user_id
    JOIN users c ON c.id = ea.client_user_id
    LEFT JOIN expert_profiles ep ON ep.user_id = ea.expert_user_id
    ORDER BY (ea.status = 'active') DESC, ea.created_at DESC, ea.id DESC
  `;
  dbAll(sql, [], res);
});

// ✅ 管理員：建立/更新指派（單筆）
app.post("/api/admin/assignments", auth, requireRole("admin"), (req, res) => {
  const { expert_user_id, client_user_id, status = "active" } = req.body || {};
  const expertId = Number(expert_user_id);
  const clientId = Number(client_user_id);

  if (!expertId || !clientId) return res.status(400).json({ message: "缺少 expert_user_id / client_user_id" });
  if (!ASSIGNMENT_STATUSES.includes(String(status))) return res.status(400).json({ message: "status 只能是 active 或 ended" });

  // 確認 expertId
  db.get(
    `SELECT id, role, COALESCE(status,'active') AS status FROM users WHERE id = ?`,
    [expertId],
    (e1, expert) => {
      if (e1) return res.status(500).json({ message: "資料庫錯誤", error: String(e1) });
      if (!expert) return res.status(404).json({ message: "找不到 expert" });
      if (expert.role !== "expert") return res.status(400).json({ message: "expert_user_id 不是 expert" });
      if (String(expert.status).toLowerCase() !== "active")
        return res.status(400).json({ message: "expert_user_id 已停用，不能指派" });

      // 確認 clientId
      db.get(
        `SELECT id, role, COALESCE(status,'active') AS status FROM users WHERE id = ?`,
        [clientId],
        (e2, client) => {
          if (e2) return res.status(500).json({ message: "資料庫錯誤", error: String(e2) });
          if (!client) return res.status(404).json({ message: "找不到 client" });
          if (client.role !== "user") return res.status(400).json({ message: "client_user_id 不是 user" });
          if (String(client.status).toLowerCase() !== "active")
            return res.status(400).json({ message: "client_user_id 已停用，不能指派" });

          db.run(
            `INSERT INTO expert_assignments (expert_user_id, client_user_id, status)
             VALUES (?,?,?)
             ON CONFLICT(expert_user_id, client_user_id) DO UPDATE SET
               status = excluded.status`,
            [expertId, clientId, String(status)],
            function (e3) {
              if (e3) return res.status(500).json({ message: "資料庫錯誤", error: String(e3) });
              res.json({ message: "指派已更新", expert_user_id: expertId, client_user_id: clientId, status });
            }
          );
        }
      );
    }
  );
});

// ✅ 管理員：批次指派（1 位學員 → 多位專家）
app.post("/api/admin/assignments/bulk", auth, requireRole("admin"), (req, res) => {
  const { client_user_id, expert_user_ids, status = "active" } = req.body || {};
  const clientId = Number(client_user_id);
  const expertIds = Array.isArray(expert_user_ids) ? expert_user_ids.map(Number).filter(Boolean) : [];

  if (!clientId || expertIds.length === 0) {
    return res.status(400).json({ message: "需要 client_user_id 與 expert_user_ids（至少一位）" });
  }
  if (!ASSIGNMENT_STATUSES.includes(String(status))) return res.status(400).json({ message: "status 只能是 active 或 ended" });

  db.get(
    `SELECT id, role, COALESCE(status,'active') AS status FROM users WHERE id = ?`,
    [clientId],
    (e1, client) => {
      if (e1) return res.status(500).json({ message: "資料庫錯誤", error: String(e1) });
      if (!client) return res.status(404).json({ message: "找不到 client" });
      if (client.role !== "user") return res.status(400).json({ message: "client_user_id 不是 user" });
      if (String(client.status).toLowerCase() !== "active")
        return res.status(400).json({ message: "client_user_id 已停用，不能指派" });

      const placeholders = expertIds.map(() => "?").join(",");
      db.all(
        `SELECT id, role, COALESCE(status,'active') AS status FROM users WHERE id IN (${placeholders})`,
        expertIds,
        (e2, rows) => {
          if (e2) return res.status(500).json({ message: "資料庫錯誤", error: String(e2) });

          const notExpert = (rows || []).filter((r) => r.role !== "expert").map((r) => r.id);
          if (rows.length !== expertIds.length) return res.status(400).json({message:"部分專家不存在或 ID 重複"});
          if (notExpert.length > 0) return res.status(400).json({ message: "以下 ID 不是 expert", bad_ids: notExpert });

          const inactive = (rows || []).filter((r) => String(r.status).toLowerCase() !== "active").map((r) => r.id);
          if (inactive.length > 0) return res.status(400).json({ message: "以下 expert 已停用，不能指派", bad_ids: inactive });

          let done = 0;
          let failed = [];

          expertIds.forEach((eid) => {
            db.run(
              `INSERT INTO expert_assignments (expert_user_id, client_user_id, status)
               VALUES (?,?,?)
               ON CONFLICT(expert_user_id, client_user_id) DO UPDATE SET
                 status = excluded.status`,
              [eid, clientId, String(status)],
              (e3) => {
                done++;
                if (e3) failed.push({ expert_user_id: eid, error: String(e3) });

                if (done === expertIds.length) {
                  if (failed.length > 0) return res.status(500).json({ message: "部分指派失敗", failed });
                  res.json({ message: "批次指派完成", client_user_id: clientId, expert_user_ids: expertIds, status });
                }
              }
            );
          });
        }
      );
    }
  );
});

// ✅ 管理員：查看某學員目前指派了哪些專家（for UI 回填）
app.get("/api/admin/clients/:clientId/assignments", auth, requireRole("admin"), (req, res) => {
  const clientId = Number(req.params.clientId);
  if (!clientId) return res.status(400).json({ message: "clientId 不正確" });

  const sql = `
    SELECT
      ea.id,
      ea.expert_user_id,
      ea.client_user_id,
      ea.status,
      ea.created_at,
      u.username AS expert_name,
      COALESCE(u.status,'active') AS expert_status,
      ep.specialty,
      ep.title
    FROM expert_assignments ea
    JOIN users u ON u.id = ea.expert_user_id
    LEFT JOIN expert_profiles ep ON ep.user_id = ea.expert_user_id
    WHERE ea.client_user_id = ?
    ORDER BY ea.created_at DESC, ea.id DESC
  `;
  dbAll(sql, [clientId], res);
});

// ✅ 管理員：停用/啟用（soft delete）
app.patch("/api/admin/users/:id/disable", auth, requireRole("admin"), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "id 不正確" });

  db.run(
    `UPDATE users
     SET status = 'inactive'
     WHERE id = ? AND role != 'admin'`,
    [id],
    function (err) {
      if (err) return res.status(500).json({ message: "資料庫錯誤", error: String(err) });
      if (this.changes === 0) return res.status(404).json({ message: "找不到使用者或不可停用" });
      res.json({ message: "已停用", id });
    }
  );
});

app.patch("/api/admin/users/:id/enable", auth, requireRole("admin"), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "id 不正確" });

  db.run(
    `UPDATE users
     SET status = 'active'
     WHERE id = ?`,
    [id],
    function (err) {
      if (err) return res.status(500).json({ message: "資料庫錯誤", error: String(err) });
      if (this.changes === 0) return res.status(404).json({ message: "找不到使用者" });
      res.json({ message: "已啟用", id });
    }
  );
});

// ================= 課程購買 / 綠界金流 / QR Code 核銷 / 發票 =================
app.get("/api/admin/source-code", auth, requireRole("admin"), (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.download(path.join(process.cwd(), "server/exports/nancy-profit-health-source.zip"), "nancy-profit-health-source.zip", (error) => {
    if (!error) return;
    if (res.headersSent) return next(error);
    res.status(error.code === "ENOENT" ? 503 : 500).json({ message: "原始碼壓縮檔暫時無法下載，請確認最新版本已發布後再試。" });
  });
});

require("./payroll")(app, { auth, requireRole });

require("./commerce")(app, { auth, requireRole, secret: SECRET });

// ================= 運動手錶同步：Strava / Apple 捷徑 =================
require("./wearables")(app, { auth, requireRole, secret: SECRET });

// ================= 404 / 500（一定要放最後） =================
app.use((req, res) => {
  res.status(404).json({ message: `Not Found: ${req.method} ${req.url}` });
});

app.use((err, req, res, next) => {
  const status = err.type === "entity.parse.failed" ? 400 : err.type === "entity.too.large" ? 413 : 500;
  console.error("Unhandled API error", { status, code: /^[A-Z0-9_]{1,40}$/.test(err.code || "") ? err.code : undefined });
  res.status(status).json({ message: status === 400 ? "JSON 資料格式不正確" : status === 413 ? "資料過大" : "伺服器錯誤" });
});


module.exports = app;
