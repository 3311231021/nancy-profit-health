CREATE TABLE expert_payroll (
  user_id INTEGER NOT NULL REFERENCES users(id),
  month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  pay_type TEXT NOT NULL CHECK (pay_type IN ('hourly','monthly','lesson')),
  rate NUMERIC(12,2) NOT NULL CHECK (rate >= 0 AND rate <= 99999999),
  lessons INTEGER NOT NULL DEFAULT 0 CHECK (lessons >= 0 AND lessons <= 10000),
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, month)
);
CREATE TABLE expert_attendance (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  clock_in TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  clock_out TIMESTAMPTZ,
  CHECK (clock_out IS NULL OR clock_out >= clock_in)
);
CREATE UNIQUE INDEX expert_one_open_shift ON expert_attendance(user_id) WHERE clock_out IS NULL;
CREATE INDEX expert_attendance_month ON expert_attendance(user_id, clock_in);
