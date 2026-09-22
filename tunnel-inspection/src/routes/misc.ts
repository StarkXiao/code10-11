import { Router } from 'express';
import type { DB } from '../db.js';
import { evaluateAll } from '../services/evaluate.js';

export function evaluateRouter(db: DB): Router {
  const r = Router();

  /** 全量评估（可挂 cron / 调度器周期触发） */
  r.post('/run', (_req, res) => {
    res.json(evaluateAll(db));
  });

  return r;
}

export function dashboardRouter(db: DB): Router {
  const r = Router();

  r.get('/summary', (_req, res) => {
    const now = new Date().toISOString();
    const rows = <T extends object>(sql: string, ...args: unknown[]) =>
      db.prepare(sql).all(...args) as T[];
    const one = <T extends object>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;

    res.json({
      cracks_by_level: rows<{ last_level: string | null; n: number }>(
        `SELECT COALESCE(last_level, 'unevaluated') AS last_level, COUNT(*) AS n
         FROM cracks WHERE status = 'active' GROUP BY last_level`,
      ),
      open_alerts_by_level: rows<{ level: string; n: number }>(
        `SELECT level, COUNT(*) AS n FROM alerts WHERE status = 'open' GROUP BY level`,
      ),
      tasks_by_status: rows<{ status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM review_tasks GROUP BY status`,
      ),
      overdue_open_tasks: one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM review_tasks
         WHERE status IN ('pending','accepted','in_progress') AND due_at < ?`,
        now,
      ).n,
      recent_alerts: rows(
        `SELECT a.id, a.level, a.status, a.created_at, c.code AS crack_code, s.code AS segment_code
         FROM alerts a
         JOIN cracks c ON c.id = a.crack_id
         JOIN segments s ON s.id = c.segment_id
         ORDER BY a.id DESC LIMIT 10`,
      ),
    });
  });

  return r;
}
