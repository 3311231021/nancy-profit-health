-- 運動手錶資料同步：Strava 授權連結、Apple 捷徑上傳金鑰，以及運動紀錄來源

-- 運動紀錄來源：manual = 手動輸入；strava = Strava 同步；apple = Apple 捷徑上傳
ALTER TABLE activity_records ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
-- 外部平台的紀錄編號（Strava 活動 ID、Apple 每日摘要日期等），用來避免重複匯入
ALTER TABLE activity_records ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE activity_records ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE activity_records ADD COLUMN IF NOT EXISTS distance_km DOUBLE PRECISION DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS activity_records_external_uniq
  ON activity_records (user_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_records_user_created_idx ON activity_records (user_id, created_at DESC);

-- Strava 授權：token 以 AES-256-GCM 加密後儲存
CREATE TABLE IF NOT EXISTS strava_connections (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  athlete_id BIGINT NOT NULL UNIQUE,
  athlete_name TEXT,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT,
  connected_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  last_sync_at TIMESTAMPTZ
);

-- Apple 捷徑上傳金鑰：只儲存 SHA-256 雜湊，明碼只在產生時顯示一次
CREATE TABLE IF NOT EXISTS shortcut_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMPTZ
);
