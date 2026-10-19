
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'active'
    )
  ;

    CREATE TABLE IF NOT EXISTS activity_records (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      activity_type TEXT,
      duration INTEGER NOT NULL,
      steps INTEGER DEFAULT 0,
      heart_rate INTEGER DEFAULT 0,
      speed DOUBLE PRECISION DEFAULT 0,
      calories INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  ;

    CREATE TABLE IF NOT EXISTS health_records (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      height DOUBLE PRECISION,
      weight DOUBLE PRECISION,
      bmi DOUBLE PRECISION,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  ;

    CREATE TABLE IF NOT EXISTS goals (
      user_id INTEGER PRIMARY KEY,
      daily_steps INTEGER DEFAULT 5000,
      daily_minutes INTEGER DEFAULT 30,
      daily_calories INTEGER DEFAULT 300,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  ;

    CREATE TABLE IF NOT EXISTS expert_profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      specialty TEXT NOT NULL,
      title TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  ;

    CREATE TABLE IF NOT EXISTS expert_assignments (
      id SERIAL PRIMARY KEY,
      expert_user_id INTEGER NOT NULL,
      client_user_id INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(expert_user_id, client_user_id),
      FOREIGN KEY (expert_user_id) REFERENCES users(id),
      FOREIGN KEY (client_user_id) REFERENCES users(id)
    )
  ;

    CREATE TABLE IF NOT EXISTS expert_notes (
      id SERIAL PRIMARY KEY,
      expert_user_id INTEGER NOT NULL,
      client_user_id INTEGER NOT NULL,
      note_type TEXT NOT NULL,             -- feedback | task
      content TEXT NOT NULL,
      target_date DATE,
      target_minutes INTEGER,
      target_steps INTEGER,
      target_calories INTEGER,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (expert_user_id) REFERENCES users(id),
      FOREIGN KEY (client_user_id) REFERENCES users(id)
    )
  ;

    CREATE TABLE IF NOT EXISTS client_questions (
      id SERIAL PRIMARY KEY,
      client_user_id INTEGER NOT NULL,
      expert_user_id INTEGER,              -- 未指派時可為 NULL
      question TEXT NOT NULL,
      reply TEXT,
      status TEXT DEFAULT 'open',          -- open | answered
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      replied_at TIMESTAMPTZ,
      FOREIGN KEY (client_user_id) REFERENCES users(id),
      FOREIGN KEY (expert_user_id) REFERENCES users(id)
    )
  ;
CREATE TABLE IF NOT EXISTS profit_setup (id INTEGER PRIMARY KEY CHECK (id=1), created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
