CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_data (
  user_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS avatars (
  user_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 片头片尾公共库（只读查询，不提供上传写入接口；数据由服务端/运营导入）
CREATE TABLE IF NOT EXISTS skip_marks_public (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_key TEXT NOT NULL,
  title TEXT,
  season INTEGER,
  episode INTEGER,
  segment_type TEXT NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  votes INTEGER NOT NULL DEFAULT 0,
  sources TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'wdtv',
  confidence REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skip_marks_public_key
  ON skip_marks_public (title_key, season, episode);
