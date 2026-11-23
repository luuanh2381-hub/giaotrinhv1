-- ============================================================================
-- New HSK 3.0 Admin Analytics & IP Security Schema (Neon PostgreSQL Singapore)
-- Run once in Neon SQL Editor (AWS ap-southeast-1)
-- ============================================================================

-- 1. Admin accounts (replaces hardcoded credentials in index.html)
CREATE TABLE IF NOT EXISTS admin_users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(24) NOT NULL DEFAULT 'super_admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- 2. Admin login audit logs (IP, geo, device, browser, status)
CREATE TABLE IF NOT EXISTS admin_login_logs (
  id BIGSERIAL PRIMARY KEY,
  username_tried VARCHAR(120) NOT NULL,
  ip_address INET NOT NULL,
  country VARCHAR(12),
  city TEXT,
  device_type VARCHAR(24),
  os_name VARCHAR(48),
  browser_name VARCHAR(48),
  user_agent TEXT,
  status VARCHAR(24) NOT NULL, -- 'success' | 'failed' | 'blocked' | 'auto_banned'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_login_logs_time
  ON admin_login_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_login_logs_ip_status_time
  ON admin_login_logs (ip_address, status, created_at DESC);

-- 3. Blocked IPs / CIDRs (source of truth; synced to Vercel Edge Config)
CREATE TABLE IF NOT EXISTS blocked_ips (
  id BIGSERIAL PRIMARY KEY,
  ip_cidr CIDR NOT NULL UNIQUE,
  scope VARCHAR(24) NOT NULL DEFAULT 'site_wide', -- 'site_wide' | 'admin_only'
  reason TEXT NOT NULL DEFAULT '',
  is_auto BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_by VARCHAR(64) NOT NULL DEFAULT 'admin',
  blocked_hits BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ, -- NULL = permanent
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blocked_ips_active
  ON blocked_ips (expires_at);

-- 4. Visitor IP summary (1 compact row per IP for Admin monitoring & 1-click blocking)
CREATE TABLE IF NOT EXISTS visitor_ip_summary (
  ip_address INET PRIMARY KEY,
  country VARCHAR(12),
  city TEXT,
  device_type VARCHAR(24),
  os_name VARCHAR(48),
  browser_name VARCHAR(48),
  total_hits BIGINT NOT NULL DEFAULT 0,
  failed_admin_logins INT NOT NULL DEFAULT 0,
  last_path TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visitor_ip_last_seen
  ON visitor_ip_summary (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_visitor_ip_total_hits
  ON visitor_ip_summary (total_hits DESC);

-- 5. Daily aggregated activity stats (rollup per date + level)
CREATE TABLE IF NOT EXISTS stats_daily (
  stat_date DATE NOT NULL,
  level VARCHAR(16) NOT NULL, -- 'ROOT' | 'HSK1' | 'HSK2' | 'HSK3' | 'HSK4'
  page_views BIGINT NOT NULL DEFAULT 0,
  flashcard_answers BIGINT NOT NULL DEFAULT 0,
  stroke_quizzes BIGINT NOT NULL DEFAULT 0,
  audio_plays BIGINT NOT NULL DEFAULT 0,
  word_lookups BIGINT NOT NULL DEFAULT 0,
  known_toggles BIGINT NOT NULL DEFAULT 0,
  streak_events BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (stat_date, level)
);

-- 6. Daily unique anonymous visitors & device breakdown (DAU / WAU / MAU)
CREATE TABLE IF NOT EXISTS stats_daily_visitors (
  stat_date DATE NOT NULL,
  visitor_id VARCHAR(64) NOT NULL,
  level VARCHAR(16) NOT NULL DEFAULT 'ROOT',
  device_type VARCHAR(24),
  os_name VARCHAR(48),
  browser_name VARCHAR(48),
  country VARCHAR(12),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stat_date, visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_stats_daily_visitors_date
  ON stats_daily_visitors (stat_date DESC);

-- 7. Per-lesson engagement stats (68 lessons across HSK1-HSK4)
CREATE TABLE IF NOT EXISTS stats_lessons (
  level VARCHAR(16) NOT NULL,
  lesson_id INT NOT NULL,
  views_vocab BIGINT NOT NULL DEFAULT 0,
  views_grammar BIGINT NOT NULL DEFAULT 0,
  views_texts BIGINT NOT NULL DEFAULT 0,
  audio_plays BIGINT NOT NULL DEFAULT 0,
  known_toggles BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (level, lesson_id)
);

-- 8. Vocabulary difficulty telemetry (Flashcard errors, stroke mistakes, dialogue lookups)
CREATE TABLE IF NOT EXISTS stats_vocab_difficulty (
  level VARCHAR(16) NOT NULL,
  lesson_id INT NOT NULL DEFAULT 0,
  hanzi VARCHAR(64) NOT NULL,
  pinyin TEXT,
  vn TEXT,
  fc_right BIGINT NOT NULL DEFAULT 0,
  fc_wrong BIGINT NOT NULL DEFAULT 0,
  popup_clicks BIGINT NOT NULL DEFAULT 0,
  stroke_quizzes BIGINT NOT NULL DEFAULT 0,
  stroke_mistakes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (level, lesson_id, hanzi)
);

CREATE INDEX IF NOT EXISTS idx_vocab_difficulty_wrong
  ON stats_vocab_difficulty (fc_wrong DESC, stroke_mistakes DESC, popup_clicks DESC);

-- 9. Search keyword telemetry (top queries & zero-result queries)
CREATE TABLE IF NOT EXISTS stats_searches (
  level VARCHAR(16) NOT NULL,
  query VARCHAR(120) NOT NULL,
  hit_count BIGINT NOT NULL DEFAULT 0,
  zero_result_count BIGINT NOT NULL DEFAULT 0,
  last_searched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (level, query)
);

CREATE INDEX IF NOT EXISTS idx_stats_searches_zero
  ON stats_searches (zero_result_count DESC, hit_count DESC);

-- 10. Anonymous streak distribution tracking
CREATE TABLE IF NOT EXISTS stats_streaks (
  visitor_id VARCHAR(64) PRIMARY KEY,
  current_streak INT NOT NULL DEFAULT 1,
  max_streak INT NOT NULL DEFAULT 1,
  reset_count INT NOT NULL DEFAULT 0,
  last_event VARCHAR(16), -- 'first' | 'continue' | 'reset' | 'same'
  last_active_date DATE NOT NULL DEFAULT CURRENT_DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Client / media asset error health monitor (broken audio/images/JS errors)
CREATE TABLE IF NOT EXISTS system_errors (
  id BIGSERIAL PRIMARY KEY,
  error_type VARCHAR(32) NOT NULL, -- 'audio_error' | 'image_error' | 'stroke_error' | 'js_error'
  level VARCHAR(16) NOT NULL DEFAULT 'ROOT',
  target_url TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  browser_name VARCHAR(48),
  os_name VARCHAR(48),
  hit_count BIGINT NOT NULL DEFAULT 1,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (error_type, level, target_url)
);

CREATE INDEX IF NOT EXISTS idx_system_errors_last_seen
  ON system_errors (last_seen_at DESC);
