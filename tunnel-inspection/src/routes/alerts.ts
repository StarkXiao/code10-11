import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { nowIso } from '../db.js';
import { HttpError, parseBody } from '../lib/http.js';

export function alertsRouter(db: DB): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const cond: string[] = [];
    const args: unknown[] = [];
    if (req.query.status) {
      cond.push('a.status = ?');
      args.push(String(req.query.status));
    }
    if (req.query.level) {
      cond.push('a.level = ?');
      args.push(String(req.query.level));
    }
    res.json(
      db
        .prepare(
          `SELECT a.*, c.code AS crack_code, s.code AS segment_code
           FROM alerts a
           JOIN cracks c ON c.id = a.crack_id
           JOIN segments s ON s.id = c.segment_id
           ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
           ORDER BY a.id DESC`,
        )
        .all(...args),
    );
  });

  /** 人工销警：联动取消未闭环的复核任务 */
  r.post('/:id/resolve', (req, res) => {
    const alertId = Number(req.params.id);
    const { note } = parseBody(z.object({ note: z.string().optional() }), req.body ?? {});
    const alert = db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(alertId) as
      | { id: number; status: string; crack_id: number }
      | undefined;
    if (!alert) throw new HttpError(404, 'NOT_FOUND', `预警 ${alertId} 不存在`);
    if (alert.status !== 'open') throw new HttpError(409, 'BAD_STATE', '预警已闭环');

    const now = nowIso();
    const run = db.transaction(() => {
      db.prepare(`UPDATE alerts SET status='resolved', resolved_at=?, resolve_note=? WHERE id=?`).run(
        now,
        note ?? '人工销警',
        alertId,
      );
      db.prepare(
        `UPDATE review_tasks SET status='cancelled', conclusion_note='预警人工关闭'
         WHERE crack_id = ? AND status IN ('pending','accepted','in_progress')`,
      ).run(alert.crack_id);
    });
    run();
    res.json({ id: alertId, status: 'resolved' });
  });

  return r;
}
