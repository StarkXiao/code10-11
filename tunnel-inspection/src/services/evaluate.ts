import type { DB } from '../db.js';
import { nowIso } from '../db.js';
import { config } from '../config.js';
import { assessTrend, type AssessLimits, type TrendAssessment } from '../analysis/trend.js';
import { ensureTask } from './dispatch.js';

/**
 * 评估服务：对裂缝跑一次趋势分析，维护预警与复核任务的生命周期。
 *
 * 触发时机：
 *  - 事件驱动：测缝计读数 / 影像识别结果入库后立即评估受影响裂缝；
 *  - 周期驱动：POST /api/evaluate/run 全量扫描（可挂 cron）。
 *
 * 闭环原则：预警只能由人闭环（复核任务结论或人工 resolve），
 * 评估引擎只负责开单与升级，绝不自动销警——避免"数据一回落就当作没事"。
 */

export interface EvalOutcome {
  crackId: number;
  assessment: TrendAssessment;
  alertId: number | null;
  taskId: number | null;
  createdAlert: boolean;
  createdTask: boolean;
  escalatedTask: boolean;
}

function limitsFor(segment: {
  width_limit_mm: number | null;
  rate_limit_mm_per_month: number | null;
}): AssessLimits {
  return {
    widthLimitMm: segment.width_limit_mm ?? config.defaults.widthLimitMm,
    rateLimitMmPerMonth: segment.rate_limit_mm_per_month ?? config.defaults.rateLimitMmPerMonth,
    warnDaysAhead: config.defaults.warnDaysAhead,
    minSamples: config.defaults.minSamples,
    watchWidthFactor: config.defaults.watchWidthFactor,
    watchRateFactor: config.defaults.watchRateFactor,
  };
}

export function evaluateCrack(db: DB, crackId: number, now: Date = new Date()): EvalOutcome {
  const crack = db
    .prepare(
      `SELECT c.id, c.segment_id, s.responsible_team, s.width_limit_mm, s.rate_limit_mm_per_month
       FROM cracks c JOIN segments s ON s.id = c.segment_id WHERE c.id = ?`,
    )
    .get(crackId) as
    | {
        id: number;
        segment_id: number;
        responsible_team: string | null;
        width_limit_mm: number | null;
        rate_limit_mm_per_month: number | null;
      }
    | undefined;
  if (!crack) throw new Error(`裂缝 ${crackId} 不存在`);

  const obs = db
    .prepare(`SELECT observed_at, width_mm FROM observations WHERE crack_id = ? ORDER BY observed_at`)
    .all(crackId) as { observed_at: string; width_mm: number }[];

  const assessment = assessTrend(
    obs.map((o) => ({ observedAt: o.observed_at, widthMm: o.width_mm })),
    limitsFor(crack),
    now,
  );

  const nowIsoStr = now.toISOString();
  db.prepare(`UPDATE cracks SET last_level = ?, last_evaluated_at = ? WHERE id = ?`).run(
    assessment.level,
    nowIsoStr,
    crackId,
  );

  const outcome: EvalOutcome = {
    crackId,
    assessment,
    alertId: null,
    taskId: null,
    createdAlert: false,
    createdTask: false,
    escalatedTask: false,
  };

  if (assessment.level !== 'warning' && assessment.level !== 'exceeded') return outcome;

  const metrics = JSON.stringify(assessment);
  const reasons = JSON.stringify(assessment.reasons);
  const openAlert = db
    .prepare(`SELECT id, level FROM alerts WHERE crack_id = ? AND status = 'open'`)
    .get(crackId) as { id: number; level: string } | undefined;

  let alertId: number;
  if (openAlert) {
    // 已有未闭环预警：刷新等级与指标快照（等级可能恶化也可能好转，由人闭环）
    db.prepare(`UPDATE alerts SET level = ?, reasons = ?, metrics = ? WHERE id = ?`).run(
      assessment.level,
      reasons,
      metrics,
      openAlert.id,
    );
    alertId = openAlert.id;
  } else {
    const info = db
      .prepare(
        `INSERT INTO alerts (crack_id, level, reasons, metrics, status, created_at)
         VALUES (?, ?, ?, ?, 'open', ?)`,
      )
      .run(crackId, assessment.level, reasons, metrics, nowIsoStr);
    alertId = Number(info.lastInsertRowid);
    outcome.createdAlert = true;
  }
  outcome.alertId = alertId;

  const task = ensureTask(db, {
    crackId,
    alertId,
    level: assessment.level,
    assignee: crack.responsible_team,
  });
  outcome.taskId = task.taskId;
  outcome.createdTask = task.created;
  outcome.escalatedTask = task.escalated;
  return outcome;
}

/** 全量评估所有在役裂缝，返回分级统计与本次新开/升级的预警任务数。 */
export function evaluateAll(db: DB, now: Date = new Date()) {
  const cracks = db.prepare(`SELECT id FROM cracks WHERE status = 'active'`).all() as {
    id: number;
  }[];
  const byLevel: Record<string, number> = {};
  let newAlerts = 0;
  let newTasks = 0;
  let escalated = 0;
  for (const { id } of cracks) {
    const r = evaluateCrack(db, id, now);
    byLevel[r.assessment.level] = (byLevel[r.assessment.level] ?? 0) + 1;
    if (r.createdAlert) newAlerts++;
    if (r.createdTask) newTasks++;
    if (r.escalatedTask) escalated++;
  }
  return { evaluated: cracks.length, byLevel, newAlerts, newTasks, escalatedTasks: escalated, ranAt: nowIso() };
}
