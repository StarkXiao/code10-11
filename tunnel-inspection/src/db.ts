import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

export type DB = Database.Database;

/**
 * 数据模型（SQLite）：
 *
 *  tunnels ──< segments ──< cracks ──< observations（统一观测序列：测缝计/影像/人工）
 *                  │            │
 *                  │            └──< gauges（测缝计，挂裂缝上）
 *                  └──< images（巡检影像，识别结果写入 observations）
 *
 *  cracks ──< alerts（同一裂缝同时只存在一条 open 预警，部分唯一索引保证）
 *  cracks ──< review_tasks（同一裂缝同时只存在一条未闭环任务，同上）
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tunnels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  line        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS segments (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  tunnel_id               INTEGER NOT NULL REFERENCES tunnels(id),
  code                    TEXT NOT NULL UNIQUE,
  start_chainage_m        REAL NOT NULL,
  end_chainage_m          REAL NOT NULL,
  lining_type             TEXT NOT NULL DEFAULT '钢筋混凝土管片',
  responsible_team        TEXT,
  width_limit_mm          REAL,           -- NULL 用全局默认
  rate_limit_mm_per_month REAL,           -- NULL 用全局默认
  created_at              TEXT NOT NULL,
  CHECK (end_chainage_m > start_chainage_m)
);

CREATE TABLE IF NOT EXISTS cracks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id        INTEGER NOT NULL REFERENCES segments(id),
  code              TEXT NOT NULL UNIQUE,
  crack_type        TEXT NOT NULL,        -- longitudinal/transverse/circumferential/oblique/map
  location_desc     TEXT,
  status            TEXT NOT NULL DEFAULT 'active',   -- active/closed
  last_level        TEXT,                 -- 最近一次评估等级（看板用）
  last_evaluated_at TEXT,
  discovered_at     TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id  INTEGER NOT NULL REFERENCES segments(id),
  uri         TEXT NOT NULL,
  taken_at    TEXT NOT NULL,
  inspector   TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gauges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  crack_id     INTEGER NOT NULL REFERENCES cracks(id),
  code         TEXT NOT NULL UNIQUE,
  installed_at TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'online'   -- online/offline
);

CREATE TABLE IF NOT EXISTS observations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  crack_id    INTEGER NOT NULL REFERENCES cracks(id),
  observed_at TEXT NOT NULL,
  width_mm    REAL NOT NULL CHECK (width_mm >= 0),
  source      TEXT NOT NULL,              -- gauge/image/manual
  gauge_id    INTEGER REFERENCES gauges(id),
  image_id    INTEGER REFERENCES images(id),
  polygon     TEXT,                       -- 影像识别轮廓（归一化坐标 JSON）
  length_m    REAL,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_obs_crack ON observations(crack_id, observed_at);
-- 同一测缝计同一时刻的读数只入一次（重传幂等）
CREATE UNIQUE INDEX IF NOT EXISTS ux_obs_gauge_time
  ON observations(gauge_id, observed_at) WHERE gauge_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  crack_id    INTEGER NOT NULL REFERENCES cracks(id),
  level       TEXT NOT NULL,              -- warning/exceeded
  reasons     TEXT NOT NULL,              -- JSON 数组，人读
  metrics     TEXT NOT NULL,              -- JSON，评估快照
  status      TEXT NOT NULL DEFAULT 'open',  -- open/resolved
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  resolve_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_alert_open ON alerts(crack_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS review_tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  crack_id     INTEGER NOT NULL REFERENCES cracks(id),
  alert_id        INTEGER NOT NULL REFERENCES alerts(id),
  priority        TEXT NOT NULL,          -- P1/P2
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending/accepted/in_progress/completed/cancelled
  assignee        TEXT,
  due_at          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  accepted_at     TEXT,
  completed_at    TEXT,
  conclusion      TEXT,                   -- confirmed/false_alarm/repaired
  conclusion_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_open ON review_tasks(crack_id)
  WHERE status IN ('pending','accepted','in_progress');
`;

export function openDb(file: string = config.dbFile): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();
