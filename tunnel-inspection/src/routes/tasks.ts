import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { parseBody } from '../lib/http.js';
import { transitionTask } from '../services/dispatch.js';

export function tasksRouter(db: DB): Router {
  const r = Router();

  r.get('/', (req, res) => {
    const cond: string[] = [];
    const args: unknown[] = [];
    if (req.query.status) {
      cond.push('t.status = ?');
      args.push(String(req.query.status));
    }
    if (req.query.assignee) {
      cond.push('t.assignee = ?');
      args.push(String(req.query.assignee));
    }
    if (req.query.overdue === '1') {
      cond.push(`t.status IN ('pending','accepted','in_progress') AND t.due_at < ?`);
      args.push(new Date().toISOString());
    }
    res.json(
      db
        .prepare(
          `SELECT t.*, c.code AS crack_code, s.code AS segment_code, s.responsible_team
           FROM review_tasks t
           JOIN cracks c ON c.id = t.crack_id
           JOIN segments s ON s.id = c.segment_id
           ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
           ORDER BY t.due_at`,
        )
        .all(...args),
    );
  });

  const action =
    (name: 'accept' | 'start' | 'complete' | 'cancel') =>
    (req: import('express').Request, res: import('express').Response) => {
      const body = parseBody(
        z.object({
          assignee: z.string().optional(),
          conclusion: z.enum(['confirmed', 'false_alarm', 'repaired']).optional(),
          note: z.string().optional(),
        }),
        req.body ?? {},
      );
      transitionTask(db, Number(req.params.id), name, body);
      res.json(db.prepare(`SELECT * FROM review_tasks WHERE id = ?`).get(Number(req.params.id)));
    };

  r.post('/:id/accept', action('accept'));
  r.post('/:id/start', action('start'));
  r.post('/:id/complete', action('complete'));
  r.post('/:id/cancel', action('cancel'));

  return r;
}
