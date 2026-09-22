import type { DB } from '../db.js';
import { nowIso } from '../db.js';
import { config } from '../config.js';

/**
 * 现场复核任务派发引擎。
 *
 * 设计要点：
 *  - 幂等：同一裂缝同时只允许一条未闭环任务（数据库部分唯一索引兜底，
 *    这里先查后插是常规路径）；
 *  - 可升级：任务未闭环期间裂缝等级恶化（预警→超限）时，原地提升优先级
 *    并收紧时限，而不是另开新单；
 *  - 状态机：pending → accepted → in_progress → completed；cancel 可从任意
 *    未闭环状态进入。complete 必须给出复核结论（confirmed/false_alarm/repaired）。
 */

export type TaskStatus = 'pending' | 'accepted' | 'in_progress' | 'completed' | 'cancelled';
export type Conclusion = 'confirmed' | 'false_alarm' | 'repaired';

export const OPEN_STATUSES: TaskStatus[] = ['pending', 'accepted', 'in_progress'];

const PRIORITY_BY_LEVEL: Record<string, string> = { exceeded: 'P1', warning: 'P2' };
const PRIORITY_RANK: Record<string, number> = { P1: 1, P2: 2 };

export function priorityForLevel(level: string): string {
  return PRIORITY_BY_LEVEL[level] ?? 'P2';
}

/** 为预警建/升复核任务。返回 { taskId, created, escalated }。 */
export function ensureTask(
  db: DB,
  args: { crackId: number; alertId: number; level: string; assignee: string | null },
  now: Date = new Date(),
): { taskId: number; created: boolean; escalated: boolean } {
  const priority = priorityForLevel(args.level);
  const slaHours = config.slaHours[priority] ?? 72;
  const dueAt = new Date(now.getTime() + slaHours * 3_600_000).toISOString();

  const open = db
    .prepare(
      `SELECT id, priority, due_at FROM review_tasks
       WHERE crack_id = ? AND status IN ('pending','accepted','in_progress')`,
    )
    .get(args.crackId) as { id: number; priority: string; due_at: string } | undefined;

  if (open) {
    // 等级恶化 → 原地升级优先级、收紧时限（不另开新单）
    if ((PRIORITY_RANK[priority] ?? 9) < (PRIORITY_RANK[open.priority] ?? 9)) {
      const tighterDue = dueAt < open.due_at ? dueAt : open.due_at;
      db.prepare(`UPDATE review_tasks SET priority = ?, due_at = ? WHERE id = ?`).run(
        priority,
        tighterDue,
        open.id,
      );
      return { taskId: open.id, created: false, escalated: true };
    }
    return { taskId: open.id, created: false, escalated: false };
  }

  const info = db
    .prepare(
      `INSERT INTO review_tasks (crack_id, alert_id, priority, status, assignee, due_at, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(args.crackId, args.alertId, priority, args.assignee, dueAt, now.toISOString());
  return { taskId: Number(info.lastInsertRowid), created: true, escalated: false };
}

const TRANSITIONS: Record<string, TaskStatus[]> = {
  accept: ['pending'],
  start: ['pending', 'accepted'],
  complete: ['accepted', 'in_progress'],
  cancel: ['pending', 'accepted', 'in_progress'],
};

export class TaskError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 任务状态推进。complete 时联动关闭/保留预警（见 evaluate.resolveAlertForTask）。 */
export function transitionTask(
  db: DB,
  taskId: number,
  action: 'accept' | 'start' | 'complete' | 'cancel',
  payload: { assignee?: string; conclusion?: Conclusion; note?: string } = {},
): void {
  const task = db.prepare(`SELECT * FROM review_tasks WHERE id = ?`).get(taskId) as
    | { id: number; status: TaskStatus; alert_id: number; crack_id: number }
    | undefined;
  if (!task) throw new TaskError('NOT_FOUND', `任务 ${taskId} 不存在`);

  const allowed = TRANSITIONS[action];
  if (!allowed.includes(task.status)) {
    throw new TaskError(
      'BAD_STATE',
      `任务当前状态 ${task.status} 不允许 ${action}（允许来源：${allowed.join('/')}）`,
    );
  }

  const now = nowIso();
  if (action === 'accept') {
    db.prepare(`UPDATE review_tasks SET status='accepted', accepted_at=?, assignee=COALESCE(?,assignee) WHERE id=?`)
      .run(now, payload.assignee ?? null, taskId);
  } else if (action === 'start') {
    db.prepare(`UPDATE review_tasks SET status='in_progress', accepted_at=COALESCE(accepted_at,?) WHERE id=?`)
      .run(now, taskId);
  } else if (action === 'complete') {
    const conclusion = payload.conclusion;
    if (!conclusion || !['confirmed', 'false_alarm', 'repaired'].includes(conclusion)) {
      throw new TaskError('BAD_INPUT', 'complete 必须给出结论 conclusion：confirmed/false_alarm/repaired');
    }
    db.prepare(
      `UPDATE review_tasks SET status='completed', completed_at=?, conclusion=?, conclusion_note=? WHERE id=?`,
    ).run(now, conclusion, payload.note ?? null, taskId);
    applyConclusion(db, task.alert_id, task.crack_id, conclusion, payload.note);
  } else {
    // cancel：联动关闭对应预警，避免评估引擎下一轮立即重派形成空转
    db.prepare(`UPDATE review_tasks SET status='cancelled', conclusion_note=? WHERE id=?`).run(
      payload.note ?? null,
      taskId,
    );
    db.prepare(
      `UPDATE alerts SET status='resolved', resolved_at=?, resolve_note=? WHERE id=? AND status='open'`,
    ).run(now, `任务取消：${payload.note ?? '未说明'}`, task.alert_id);
  }
}

function applyConclusion(
  db: DB,
  alertId: number,
  crackId: number,
  conclusion: Conclusion,
  note?: string,
): void {
  const now = nowIso();
  if (conclusion === 'false_alarm' || conclusion === 'repaired') {
    // 误报 / 已处置 → 预警闭环
    db.prepare(
      `UPDATE alerts SET status='resolved', resolved_at=?, resolve_note=? WHERE id=? AND status='open'`,
    ).run(now, `现场复核${conclusion === 'false_alarm' ? '确认为误报' : '确认已处置'}${note ? `：${note}` : ''}`, alertId);
  }
  if (conclusion === 'repaired') {
    db.prepare(`UPDATE cracks SET status='closed' WHERE id=?`).run(crackId);
  }
  // confirmed：预警保持 open，等待处置流程（注浆/嵌缝等，超出本系统范围，见 README）
}
