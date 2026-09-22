import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { nowIso } from '../db.js';
import { HttpError, parseBody } from '../lib/http.js';

const tunnelSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  line: z.string().optional(),
});

const segmentSchema = z.object({
  code: z.string().min(1),
  start_chainage_m: z.number(),
  end_chainage_m: z.number(),
  lining_type: z.string().default('钢筋混凝土管片'),
  responsible_team: z.string().optional(),
  width_limit_mm: z.number().positive().optional(),
  rate_limit_mm_per_month: z.number().positive().optional(),
});

export function tunnelsRouter(db: DB): Router {
  const r = Router();

  r.post('/', (req, res) => {
    const body = parseBody(tunnelSchema, req.body);
    const info = db
      .prepare(`INSERT INTO tunnels (code, name, line, created_at) VALUES (?, ?, ?, ?)`)
      .run(body.code, body.name, body.line ?? null, nowIso());
    res.status(201).json({ id: Number(info.lastInsertRowid), ...body });
  });

  r.get('/', (_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT t.*, (SELECT COUNT(*) FROM segments s WHERE s.tunnel_id = t.id) AS segment_count
           FROM tunnels t ORDER BY t.id`,
        )
        .all(),
    );
  });

  r.post('/:id/segments', (req, res) => {
    const tunnelId = Number(req.params.id);
    if (!db.prepare(`SELECT id FROM tunnels WHERE id = ?`).get(tunnelId)) {
      throw new HttpError(404, 'NOT_FOUND', `隧道 ${tunnelId} 不存在`);
    }
    const body = parseBody(segmentSchema, req.body);
    if (body.end_chainage_m <= body.start_chainage_m) {
      throw new HttpError(400, 'VALIDATION', '终点里程必须大于起点里程');
    }
    const info = db
      .prepare(
        `INSERT INTO segments (tunnel_id, code, start_chainage_m, end_chainage_m, lining_type,
                               responsible_team, width_limit_mm, rate_limit_mm_per_month, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tunnelId,
        body.code,
        body.start_chainage_m,
        body.end_chainage_m,
        body.lining_type,
        body.responsible_team ?? null,
        body.width_limit_mm ?? null,
        body.rate_limit_mm_per_month ?? null,
        nowIso(),
      );
    res.status(201).json({ id: Number(info.lastInsertRowid), tunnel_id: tunnelId, ...body });
  });

  r.get('/:id/segments', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT s.*, (SELECT COUNT(*) FROM cracks c WHERE c.segment_id = s.id AND c.status='active') AS crack_count
           FROM segments s WHERE s.tunnel_id = ? ORDER BY s.start_chainage_m`,
        )
        .all(Number(req.params.id)),
    );
  });

  return r;
}
