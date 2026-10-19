-- 課程上架、購課訂單（綠界刷卡）、學員堂數票券、QR Code 核銷與電子發票

-- 課程：session_pack = 堂數課程（例如教練 1 對 1 十堂）；event = 講座／活動入場券
CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  course_type TEXT NOT NULL DEFAULT 'session_pack' CHECK (course_type IN ('session_pack','event')),
  price INTEGER NOT NULL CHECK (price > 0),
  sessions INTEGER NOT NULL DEFAULT 1 CHECK (sessions > 0),
  expert_user_id INTEGER REFERENCES users(id),
  event_at TIMESTAMPTZ,
  location TEXT,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  valid_days INTEGER CHECK (valid_days IS NULL OR valid_days > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 訂單：pending → paid / failed
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  merchant_trade_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  item_name TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  invoice_type TEXT NOT NULL DEFAULT 'member' CHECK (invoice_type IN ('member','mobile','donation','company')),
  carrier_num TEXT,
  love_code TEXT,
  company_tax_id TEXT,
  company_name TEXT,
  company_address TEXT,
  ecpay_trade_no TEXT,
  payment_type TEXT,
  rtn_msg TEXT,
  simulated BOOLEAN NOT NULL DEFAULT FALSE,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_paid_idx ON orders(status, paid_at);

-- 學員票券（付款成功後產生），remaining_sessions 由 QR Code 核銷扣除
CREATE TABLE IF NOT EXISTS enrollments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  total_sessions INTEGER NOT NULL CHECK (total_sessions > 0),
  remaining_sessions INTEGER NOT NULL CHECK (remaining_sessions >= 0),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS enrollments_user_idx ON enrollments(user_id);
CREATE INDEX IF NOT EXISTS enrollments_course_idx ON enrollments(course_id);

-- 核銷紀錄；qr_nonce 讓每一個 QR Code 只能使用一次
CREATE TABLE IF NOT EXISTS redemptions (
  id SERIAL PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  redeemed_by INTEGER NOT NULL REFERENCES users(id),
  sessions_used INTEGER NOT NULL DEFAULT 1 CHECK (sessions_used > 0),
  qr_nonce TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','revoked')),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS redemptions_course_idx ON redemptions(course_id, created_at DESC);
CREATE INDEX IF NOT EXISTS redemptions_enrollment_idx ON redemptions(enrollment_id);

-- 電子發票（綠界 B2C）
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','issued','failed','void')),
  relate_number TEXT,
  invoice_no TEXT,
  invoice_date TEXT,
  random_number TEXT,
  amount INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
