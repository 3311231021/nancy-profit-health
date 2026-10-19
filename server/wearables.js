// 運動手錶資料同步：Strava 串接（OAuth + Webhook）與 Apple 捷徑上傳
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const db = require("./database");

const STRAVA_OAUTH = "https://www.strava.com/oauth";
const STRAVA_API = "https://www.strava.com/api/v3";
const STRAVA_SCOPE = "read,activity:read_all";
const INITIAL_SYNC_DAYS = 30;
const AUTO_SYNC_MINUTES = 10;
const DEFAULT_WEIGHT = 60;

// 與運動紀錄頁相同的 MET 值，用於沒有卡路里資料時的估算
const MET_TABLE = { "走路": 3.3, "跑步": 8.0, "健身": 6.0, "瑜伽": 3.0, "單車": 6.8, "教練訓練": 6.0 };

// Strava sport_type → 網站運動種類
const STRAVA_TYPES = {
  Walk: "走路", Hike: "走路",
  Run: "跑步", TrailRun: "跑步", VirtualRun: "跑步",
  Ride: "單車", VirtualRide: "單車", EBikeRide: "單車", MountainBikeRide: "單車", GravelRide: "單車", EMountainBikeRide: "單車", Velomobile: "單車", Handcycle: "單車",
  WeightTraining: "健身", Crossfit: "健身", Workout: "健身", HighIntensityIntervalTraining: "健身",
  Yoga: "瑜伽", Pilates: "瑜伽",
};
const OTHER_NAMES = {
  Swim: "游泳", Badminton: "羽球", Tennis: "網球", TableTennis: "桌球", Squash: "壁球", Pickleball: "匹克球",
  Elliptical: "橢圓機", StairStepper: "踏步機", Rowing: "划船", VirtualRow: "划船機", Canoeing: "獨木舟", Kayaking: "獨木舟",
  StandUpPaddling: "立槳", Surfing: "衝浪", Soccer: "足球", RockClimbing: "攀岩", InlineSkate: "直排輪", Golf: "高爾夫",
  AlpineSki: "滑雪", NordicSki: "越野滑雪", Snowboard: "滑雪板", IceSkate: "溜冰", Skateboard: "滑板", Wheelchair: "輪椅",
};

function safeCode(err) {
  return /^[A-Z0-9_]{1,40}$/.test(err?.code || "") ? err.code : undefined;
}

function baseUrl(req) {
  if (process.env.SITE_BASE_URL) return process.env.SITE_BASE_URL.replace(/\/$/, "");
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  return (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http://" : "https://") + host;
}

function stravaConfig() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function mapActivityType(raw) {
  const name = String(raw || "").trim();
  if (!name) return "其他";
  if (STRAVA_TYPES[name]) return STRAVA_TYPES[name];
  if (OTHER_NAMES[name]) return `其他：${OTHER_NAMES[name]}`;
  // Apple 健康的中文體能訓練名稱
  if (/跑/.test(name)) return "跑步";
  if (/走|健行|登山/.test(name)) return "走路";
  if (/單車|自行車|騎/.test(name)) return "單車";
  if (/瑜伽|皮拉提斯/.test(name)) return "瑜伽";
  if (/肌力|重量|健身|間歇|核心|交叉訓練/.test(name)) return "健身";
  if (/^(running|run)/i.test(name)) return "跑步";
  if (/^(walking|walk|hiking)/i.test(name)) return "走路";
  if (/cycling|bik/i.test(name)) return "單車";
  if (/yoga|pilates/i.test(name)) return "瑜伽";
  if (/strength|hiit|functional|core|training/i.test(name)) return "健身";
  return `其他：${name.slice(0, 20)}`;
}

function estimateCalories(type, minutes) {
  return Math.round((MET_TABLE[type] || 4) * DEFAULT_WEIGHT * (minutes / 60));
}

// 寬鬆解析捷徑送來的數字（可能是 "7,123"、"7123.0" 或含單位的字串）
function num(v, max) {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.\-]/g, ""));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

// ================= token 加密（AES-256-GCM，金鑰由 JWT_SECRET 衍生） =================
function cipherKey(secret) {
  return crypto.createHash("sha256").update("profit-wearable-token:" + secret).digest();
}
function encrypt(secret, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cipherKey(secret), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}
function decrypt(secret, payload) {
  const [iv, tag, enc] = String(payload).split(".").map((s) => Buffer.from(s, "base64url"));
  const d = crypto.createDecipheriv("aes-256-gcm", cipherKey(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

// ================= 寫入運動紀錄（以來源 + 外部編號去重） =================
async function upsertActivity(r) {
  const result = await db.query(
    `INSERT INTO activity_records
       (user_id, activity_type, duration, steps, heart_rate, speed, calories, created_at, source, external_id, title, distance_km)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (user_id, source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
       activity_type = excluded.activity_type, duration = excluded.duration, steps = excluded.steps,
       heart_rate = excluded.heart_rate, speed = excluded.speed, calories = excluded.calories,
       created_at = excluded.created_at, title = excluded.title, distance_km = excluded.distance_km
     RETURNING id, (xmax = 0) AS inserted`,
    [r.userId, r.type, r.duration, r.steps || 0, r.heartRate || 0, r.speed || 0, r.calories || 0,
      r.startedAt, r.source, r.externalId, r.title || null, r.distanceKm || 0]
  );
  return result.rows[0];
}

function stravaRecord(userId, a) {
  const type = mapActivityType(a.sport_type || a.type);
  const duration = Math.max(1, Math.round(Number(a.moving_time || a.elapsed_time || 0) / 60));
  // 詳細資料有 calories；列表只有騎乘的 kilojoules（約等於消耗大卡）
  const calories = Math.round(Number(a.calories) || Number(a.kilojoules) || estimateCalories(type, duration));
  return {
    userId,
    type,
    duration,
    heartRate: Math.round(Number(a.average_heartrate) || 0),
    speed: Math.round((Number(a.average_speed) || 0) * 3.6 * 10) / 10,
    calories,
    distanceKm: Math.round((Number(a.distance) || 0) / 10) / 100,
    startedAt: a.start_date || new Date().toISOString(),
    source: "strava",
    externalId: String(a.id),
    title: a.name ? String(a.name).slice(0, 100) : null,
  };
}

module.exports = function wearables(app, { auth, requireRole, secret }) {
  const webhookVerifyToken = crypto.createHmac("sha256", secret).update("strava-webhook").digest("hex").slice(0, 32);

  // ================= Strava API 呼叫 =================
  async function stravaFetch(url, options = {}) {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error("Strava request failed");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function exchangeToken(params) {
    const cfg = stravaConfig();
    return stravaFetch(`${STRAVA_OAUTH}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }),
    });
  }

  async function getConnection(userId) {
    return (await db.query(`SELECT * FROM strava_connections WHERE user_id = ?`, [userId])).rows[0];
  }

  async function removeConnection(userId) {
    await db.query(`DELETE FROM strava_connections WHERE user_id = ?`, [userId]);
  }

  // 取得有效的 access token；快過期時自動更新
  async function accessToken(conn) {
    let access, refresh;
    try {
      access = decrypt(secret, conn.access_token_enc);
      refresh = decrypt(secret, conn.refresh_token_enc);
    } catch {
      await removeConnection(conn.user_id);
      const err = new Error("Strava token unreadable");
      err.status = 401;
      throw err;
    }
    if (new Date(conn.expires_at).getTime() > Date.now() + 120 * 1000) return access;
    try {
      const t = await exchangeToken({ grant_type: "refresh_token", refresh_token: refresh });
      await db.query(
        `UPDATE strava_connections SET access_token_enc = ?, refresh_token_enc = ?, expires_at = to_timestamp(?) WHERE user_id = ?`,
        [encrypt(secret, t.access_token), encrypt(secret, t.refresh_token), Number(t.expires_at), conn.user_id]
      );
      return t.access_token;
    } catch (err) {
      // 學員已在 Strava 取消授權
      if (err.status === 400 || err.status === 401) await removeConnection(conn.user_id);
      throw err;
    }
  }

  async function syncStrava(conn, { force = false } = {}) {
    if (!force && conn.last_sync_at && Date.now() - new Date(conn.last_sync_at).getTime() < AUTO_SYNC_MINUTES * 60 * 1000) {
      return { imported: 0, updated: 0, skipped: true };
    }
    const token = await accessToken(conn);
    const since = conn.last_sync_at
      ? new Date(conn.last_sync_at).getTime() - 2 * 86400 * 1000
      : Date.now() - INITIAL_SYNC_DAYS * 86400 * 1000;
    let imported = 0, updated = 0;
    for (let page = 1; page <= 3; page++) {
      const list = await stravaFetch(
        `${STRAVA_API}/athlete/activities?after=${Math.floor(since / 1000)}&per_page=50&page=${page}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!Array.isArray(list) || list.length === 0) break;
      for (const a of list) {
        const row = await upsertActivity(stravaRecord(conn.user_id, a));
        row.inserted ? imported++ : updated++;
      }
      if (list.length < 50) break;
    }
    await db.query(`UPDATE strava_connections SET last_sync_at = CURRENT_TIMESTAMP WHERE user_id = ?`, [conn.user_id]);
    return { imported, updated, skipped: false };
  }

  function stravaError(res, err, label) {
    console.error(label, { status: err.status, code: safeCode(err) });
    if (err.status === 401 || err.status === 400) {
      return res.status(409).json({ message: "Strava 授權已失效，請重新連結 Strava" });
    }
    if (err.status === 429) return res.status(429).json({ message: "Strava 目前請求過多，請 15 分鐘後再試" });
    res.status(502).json({ message: "暫時無法連線 Strava，請稍後再試" });
  }

  // ================= Strava：學員端 =================
  app.get("/api/strava/status", auth, async (req, res) => {
    try {
      const conn = await getConnection(req.user.id);
      res.json({
        configured: !!stravaConfig(),
        connected: !!conn,
        athlete_name: conn?.athlete_name || null,
        connected_at: conn?.connected_at || null,
        last_sync_at: conn?.last_sync_at || null,
      });
    } catch (err) {
      console.error("Strava status failed", { code: safeCode(err) });
      res.status(500).json({ message: "資料庫錯誤，請稍後再試" });
    }
  });

  app.post("/api/strava/connect", auth, (req, res) => {
    const cfg = stravaConfig();
    if (!cfg) return res.status(503).json({ message: "網站尚未設定 Strava 串接，請聯絡管理員" });
    const state = jwt.sign({ uid: req.user.id, purpose: "strava-connect" }, secret, { expiresIn: "10m" });
    const url = new URL(`${STRAVA_OAUTH}/authorize`);
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: `${baseUrl(req)}/api/strava/callback`,
      response_type: "code",
      approval_prompt: "auto",
      scope: STRAVA_SCOPE,
      state,
    }).toString();
    res.json({ url: url.toString() });
  });

  // Strava 授權完成後導回此網址（瀏覽器直接開啟，沒有登入 token，以 state 辨識學員）
  app.get("/api/strava/callback", async (req, res) => {
    const back = (status) => res.redirect(302, `/activity.html?strava=${status}`);
    if (req.query.error) return back("denied");
    let uid;
    try {
      const payload = jwt.verify(String(req.query.state || ""), secret);
      if (payload.purpose !== "strava-connect") throw new Error("bad state");
      uid = payload.uid;
    } catch {
      return back("expired");
    }
    const scope = String(req.query.scope || "");
    if (!/activity:read/.test(scope)) return back("scope");
    if (!stravaConfig() || !req.query.code) return back("error");
    try {
      const t = await exchangeToken({ code: String(req.query.code), grant_type: "authorization_code" });
      const athlete = t.athlete || {};
      const name = [athlete.firstname, athlete.lastname].filter(Boolean).join(" ").slice(0, 80) || null;
      // 同一個 Strava 帳號只能連結一位學員；改連到新帳號時移除舊的連結
      await db.query(`DELETE FROM strava_connections WHERE athlete_id = ? AND user_id <> ?`, [athlete.id, uid]);
      await db.query(
        `INSERT INTO strava_connections (user_id, athlete_id, athlete_name, access_token_enc, refresh_token_enc, expires_at, scope, last_sync_at)
         VALUES (?,?,?,?,?,to_timestamp(?),?,NULL)
         ON CONFLICT (user_id) DO UPDATE SET athlete_id = excluded.athlete_id, athlete_name = excluded.athlete_name,
           access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
           expires_at = excluded.expires_at, scope = excluded.scope, connected_at = CURRENT_TIMESTAMP, last_sync_at = NULL`,
        [uid, athlete.id, name, encrypt(secret, t.access_token), encrypt(secret, t.refresh_token), Number(t.expires_at), scope]
      );
      try {
        await syncStrava(await getConnection(uid), { force: true });
      } catch (err) {
        console.error("Strava initial sync failed", { status: err.status });
      }
      back("connected");
    } catch (err) {
      console.error("Strava connect failed", { status: err.status, code: safeCode(err) });
      back("error");
    }
  });

  app.post("/api/strava/sync", auth, async (req, res) => {
    if (!stravaConfig()) return res.status(503).json({ message: "網站尚未設定 Strava 串接" });
    try {
      const conn = await getConnection(req.user.id);
      if (!conn) return res.status(404).json({ message: "尚未連結 Strava" });
      const r = await syncStrava(conn, { force: !!req.body?.force });
      res.json({
        ...r,
        message: r.skipped ? "最近已同步過" : `同步完成：新增 ${r.imported} 筆，更新 ${r.updated} 筆`,
      });
    } catch (err) {
      stravaError(res, err, "Strava sync failed");
    }
  });

  app.post("/api/strava/disconnect", auth, async (req, res) => {
    try {
      const conn = await getConnection(req.user.id);
      if (!conn) return res.json({ message: "已取消連結" });
      try {
        const token = await accessToken(conn);
        await stravaFetch(`${STRAVA_OAUTH}/deauthorize`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ access_token: token }),
        });
      } catch (err) {
        console.error("Strava deauthorize failed", { status: err.status });
      }
      await removeConnection(req.user.id);
      res.json({ message: "已取消連結 Strava，先前匯入的紀錄會保留" });
    } catch (err) {
      console.error("Strava disconnect failed", { code: safeCode(err) });
      res.status(500).json({ message: "資料庫錯誤，請稍後再試" });
    }
  });

  // ================= Strava Webhook（運動結束後 Strava 主動通知） =================
  app.get("/api/strava/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === webhookVerifyToken) {
      return res.json({ "hub.challenge": String(req.query["hub.challenge"] || "") });
    }
    res.status(403).json({ message: "Forbidden" });
  });

  app.post("/api/strava/webhook", async (req, res) => {
    const e = req.body || {};
    try {
      const athleteId = Number(e.owner_id);
      if (!stravaConfig() || !Number.isSafeInteger(athleteId)) return res.json({ ok: true });
      const conn = (await db.query(`SELECT * FROM strava_connections WHERE athlete_id = ?`, [athleteId])).rows[0];
      if (!conn) return res.json({ ok: true });

      // 通知內容不可盡信，一律用學員的 token 向 Strava 確認後才寫入或刪除
      if (e.object_type === "athlete" && e.updates?.authorized === "false") {
        try {
          const token = await accessToken(conn);
          await stravaFetch(`${STRAVA_API}/athlete`, { headers: { Authorization: `Bearer ${token}` } });
        } catch (err) {
          if (err.status === 401) await removeConnection(conn.user_id);
        }
        return res.json({ ok: true });
      }
      if (e.object_type !== "activity" || !/^\d{1,20}$/.test(String(e.object_id))) return res.json({ ok: true });

      const token = await accessToken(conn);
      try {
        const a = await stravaFetch(`${STRAVA_API}/activities/${e.object_id}`, { headers: { Authorization: `Bearer ${token}` } });
        if (Number(a.athlete?.id) === athleteId) await upsertActivity(stravaRecord(conn.user_id, a));
      } catch (err) {
        if (err.status !== 404) throw err;
        // 活動已在 Strava 刪除（或改為無法讀取）
        await db.query(
          `DELETE FROM activity_records WHERE user_id = ? AND source = 'strava' AND external_id = ?`,
          [conn.user_id, String(e.object_id)]
        );
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("Strava webhook failed", { status: err.status, code: safeCode(err) });
      // 回 500 讓 Strava 稍後重送；寫入以活動編號去重，重送不會重複
      res.status(500).json({ ok: false });
    }
  });

  // ================= Strava：管理員設定 Webhook 訂閱 =================
  function subscriptionParams() {
    const cfg = stravaConfig();
    return new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret });
  }

  app.get("/api/admin/strava", auth, requireRole("admin"), async (req, res) => {
    const callbackUrl = `${baseUrl(req)}/api/strava/webhook`;
    if (!stravaConfig()) return res.json({ configured: false, callback_url: callbackUrl, subscription: null });
    try {
      const subs = await stravaFetch(`${STRAVA_API}/push_subscriptions?${subscriptionParams()}`);
      const [connections] = (await db.query(`SELECT COUNT(*)::int AS n FROM strava_connections`)).rows;
      res.json({
        configured: true,
        callback_url: callbackUrl,
        connected_users: connections.n,
        subscription: Array.isArray(subs) && subs[0] ? { id: subs[0].id, callback_url: subs[0].callback_url } : null,
      });
    } catch (err) {
      stravaError(res, err, "Strava subscription status failed");
    }
  });

  app.post("/api/admin/strava/subscribe", auth, requireRole("admin"), async (req, res) => {
    if (!stravaConfig()) return res.status(503).json({ message: "請先在 Netlify 設定 STRAVA_CLIENT_ID 與 STRAVA_CLIENT_SECRET" });
    const callbackUrl = `${baseUrl(req)}/api/strava/webhook`;
    try {
      // Strava 每個應用程式只能有一個訂閱；網址不同時先刪除舊的
      const subs = await stravaFetch(`${STRAVA_API}/push_subscriptions?${subscriptionParams()}`);
      for (const s of Array.isArray(subs) ? subs : []) {
        if (s.callback_url === callbackUrl) return res.json({ message: "Webhook 已啟用", id: s.id });
        await fetch(`${STRAVA_API}/push_subscriptions/${s.id}?${subscriptionParams()}`, { method: "DELETE", signal: AbortSignal.timeout(8000) });
      }
      const body = subscriptionParams();
      body.set("callback_url", callbackUrl);
      body.set("verify_token", webhookVerifyToken);
      const created = await stravaFetch(`${STRAVA_API}/push_subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      res.json({ message: "Webhook 已啟用，學員在 Strava 完成運動後會自動同步", id: created.id });
    } catch (err) {
      console.error("Strava subscribe failed", { status: err.status });
      res.status(502).json({ message: "Strava 無法驗證 Webhook 網址，請確認網站已部署且網址可公開連線" });
    }
  });

  // ================= Apple 捷徑：上傳金鑰 =================
  app.get("/api/shortcut/token", auth, async (req, res) => {
    try {
      const row = (await db.query(`SELECT token_hint, created_at, last_used_at FROM shortcut_tokens WHERE user_id = ?`, [req.user.id])).rows[0];
      res.json({
        upload_url: `${baseUrl(req)}/api/shortcut/upload`,
        has_token: !!row,
        token_hint: row?.token_hint || null,
        created_at: row?.created_at || null,
        last_used_at: row?.last_used_at || null,
      });
    } catch (err) {
      console.error("Shortcut token status failed", { code: safeCode(err) });
      res.status(500).json({ message: "資料庫錯誤，請稍後再試" });
    }
  });

  // 產生新金鑰（舊金鑰立即失效）；明碼只回傳這一次
  app.post("/api/shortcut/token", auth, async (req, res) => {
    const token = "pfh_" + crypto.randomBytes(24).toString("base64url");
    try {
      await db.query(
        `INSERT INTO shortcut_tokens (user_id, token_hash, token_hint) VALUES (?,?,?)
         ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, token_hint = excluded.token_hint,
           created_at = CURRENT_TIMESTAMP, last_used_at = NULL`,
        [req.user.id, sha256(token), token.slice(-4)]
      );
      res.json({ token, upload_url: `${baseUrl(req)}/api/shortcut/upload`, message: "已產生新的上傳金鑰" });
    } catch (err) {
      console.error("Shortcut token create failed", { code: safeCode(err) });
      res.status(500).json({ message: "資料庫錯誤，請稍後再試" });
    }
  });

  app.delete("/api/shortcut/token", auth, async (req, res) => {
    try {
      await db.query(`DELETE FROM shortcut_tokens WHERE user_id = ?`, [req.user.id]);
      res.json({ message: "已停用上傳金鑰，捷徑將無法再上傳" });
    } catch (err) {
      console.error("Shortcut token delete failed", { code: safeCode(err) });
      res.status(500).json({ message: "資料庫錯誤，請稍後再試" });
    }
  });

  // ================= Apple 捷徑：上傳健康資料 =================
  // 捷徑以「取得 URL 的內容」POST JSON，標頭 Authorization: Bearer <上傳金鑰>
  app.post("/api/shortcut/upload", async (req, res) => {
    const h = req.get("authorization") || "";
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : String(req.get("x-profit-token") || "").trim();
    if (!/^pfh_[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(401).json({ message: "上傳金鑰不正確，請到網站「運動紀錄」頁重新產生" });
    let userId;
    try {
      const row = (await db.query(
        `SELECT st.user_id FROM shortcut_tokens st JOIN users u ON u.id = st.user_id
         WHERE st.token_hash = ? AND COALESCE(u.status,'active') = 'active'`,
        [sha256(token)]
      )).rows[0];
      if (!row) return res.status(401).json({ message: "上傳金鑰已失效，請到網站「運動紀錄」頁重新產生" });
      userId = row.user_id;
    } catch (err) {
      console.error("Shortcut auth failed", { code: safeCode(err) });
      return res.status(503).json({ message: "暫時無法上傳，請稍後再試" });
    }

    const b = req.body || {};
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
    const dateMatch = String(b.date || today).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!dateMatch) return res.status(400).json({ message: "日期格式請使用 yyyy-MM-dd" });
    const date = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
    const dateMs = Date.parse(`${date}T12:00:00+08:00`);
    if (!Number.isFinite(dateMs) || dateMs > Date.now() + 86400 * 1000 || dateMs < Date.now() - 366 * 86400 * 1000) {
      return res.status(400).json({ message: "日期需在一年內且不可是未來日期" });
    }

    // 選填：個別體能訓練（Workouts）
    const workouts = (Array.isArray(b.workouts) ? b.workouts : []).slice(0, 30).map((w) => {
      const type = mapActivityType(w?.type);
      const start = Date.parse(String(w?.start || ""));
      const duration = Math.round(num(w?.duration, 1440));
      return {
        type,
        duration,
        start: Number.isFinite(start) ? new Date(start).toISOString() : null,
        calories: Math.round(num(w?.calories, 20000)) || estimateCalories(type, duration),
        heartRate: Math.round(num(w?.heart_rate, 250)),
        distanceKm: Math.round(num(w?.distance_km, 1000) * 100) / 100,
      };
    }).filter((w) => w.duration > 0 && w.start);

    const steps = Math.round(num(b.steps, 200000));
    const minutes = Math.round(num(b.exercise_minutes, 1440));
    const calories = Math.round(num(b.active_calories, 20000));
    const heartRate = Math.round(num(b.heart_rate, 250));
    const distanceKm = Math.round(num(b.distance_km, 1000) * 100) / 100;
    if (!steps && !minutes && !calories && workouts.length === 0) {
      return res.status(400).json({ message: "沒有收到任何健康資料，請確認捷徑有讀取步數或運動時間" });
    }

    try {
      for (const w of workouts) {
        await upsertActivity({
          userId, type: w.type, duration: w.duration, heartRate: w.heartRate, calories: w.calories,
          distanceKm: w.distanceKm, speed: w.distanceKm ? Math.round((w.distanceKm / (w.duration / 60)) * 10) / 10 : 0,
          startedAt: w.start, source: "apple", externalId: `workout:${w.start}`, title: "Apple Watch 體能訓練",
        });
      }
      // 每日摘要扣除同一天已上傳的體能訓練，避免總覽重複計算分鐘與卡路里
      const sameDay = workouts.filter((w) => new Date(w.start).toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }) === date);
      const workoutMinutes = sameDay.reduce((s, w) => s + w.duration, 0);
      const workoutCalories = sameDay.reduce((s, w) => s + w.calories, 0);
      await upsertActivity({
        userId,
        type: "Apple Watch 每日活動",
        duration: Math.max(0, minutes - workoutMinutes),
        steps,
        heartRate,
        calories: Math.max(0, calories - workoutCalories),
        distanceKm,
        startedAt: new Date(dateMs).toISOString(),
        source: "apple",
        externalId: `daily:${date}`,
        title: "每日步數與活動摘要",
      });
      await db.query(`UPDATE shortcut_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE user_id = ?`, [userId]);
      const parts = [`步數 ${steps.toLocaleString("en-US")}`, `運動 ${minutes} 分鐘`, `活動能量 ${calories} 大卡`];
      if (workouts.length) parts.push(`體能訓練 ${workouts.length} 筆`);
      res.json({ ok: true, date, message: `ProFit Health 已同步 ${date}：${parts.join("、")}` });
    } catch (err) {
      console.error("Shortcut upload failed", { code: safeCode(err) });
      res.status(500).json({ message: "儲存失敗，請稍後再試" });
    }
  });
};

module.exports.mapActivityType = mapActivityType;
