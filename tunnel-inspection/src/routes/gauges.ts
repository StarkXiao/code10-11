import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../db.js';
import { nowIso } from '../db.js';
import { HttpError, parseBody } from '../lib/http.js';
import { evaluateCrack } from '../services/evaluate.js';

const gaugeSchema = z.object({
  crack_id: z.number().int(),
  code: z.string().min(1),
  installed_at: z.string().optional(),
});

const readingsSchema = z.object({
  readings: z
    .array(z.object({ observed_at: z.string(), width_mm: z.number().nonnegative() }))
    .min(1),
});

export function gaugesRouter(db: DB): Router {
  const r = Router();

  r.post('/', (req, res) => {
    const body = parseBody(gaugeSchema, req.body);
    if (!db.prepare(`SELECT id FROM cracks WHERE id = ?`).get(body.crack_id)) {
      throw new HttpError(404, 'NOT_FOUND', `裂缝 ${body.crack_id} 不存在`);
    }
    const info = db
      .prepare(`INSERT INTO gauges (crack_id, code, installed_at) VALUES (?, ?, ?)`)
      .run(body.crack_id, body.code, body.installed_at ?? nowIso());
    res.status(201).json({ id: Number(info.lastInsertRowid), status: 'online', ...body });
  });

  /**
   * 测缝计读数批量上报。同一测缝计同一时刻的读数靠唯一索引去重（INSERT OR IGNORE），
   * 网关重传不会产生重复观测。入库后立即评估所属裂缝。
   */
  r.post('/:id/readings', (req, res) => {
    const gaugeId = Number(req.params.id);
    const gauge = db.prepare(`SELECT * FROM gauges WHERE id = ?`).get(gaugeId) as
      | { id: number; crack_id: number }
      | undefined;
    if (!gauge) throw new HttpError(404, 'NOT_FOUND', `测缝计 ${gaugeId} 不存在`);
    const body = parseBody(readingsSchema, req.body);

    const now = nowIso();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO observations (crack_id, observed_at, width_mm, source, gauge_id, created_at)
       VALUES (?, ?, ?, 'gauge', ?, ?)`,
    );
    let inserted = 0;
    const run = db.transaction(() => {
      for (const rd of body.readings) {
        inserted += insert.run(gauge.crack_id, rd.observed_at, rd.width_mm, gaugeId, now).changes;
      }
    });
    run();

    const evaluation = evaluateCrack(db, gauge.crack_id);
    res.status(201).json({ inserted, skipped: body.readings.length - inserted, evaluation });
  });

  r.get('/', (_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT g.*, c.code AS crack_code,
                  (SELECT COUNT(*) FROM observations o WHERE o.gauge_id = g.id) AS reading_count
           FROM gauges g JOIN cracks c ON c.id = g.crack_id ORDER BY g.id`,
        )
        .all(),
    );
  });

  return r;
}
