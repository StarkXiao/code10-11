/**
 * 全局配置：判定阈值与派单 SLA。
 *
 * 阈值默认值参考《公路隧道养护技术规范》(JTG H12) 与 GB 50446 对
 * 钢筋混凝土管片裂缝宽度的限值口径（0.2mm），均可在段落（segment）
 * 级别按衬砌类型覆盖。
 */
export const config = {
  port: Number(process.env.PORT ?? 3100),
  dbFile: process.env.DB_FILE ?? new URL('../data/tunnel-inspection.db', import.meta.url).pathname,

  defaults: {
    /** 裂缝宽度限值 mm：当前缝宽 ≥ 该值即判超限 */
    widthLimitMm: 0.2,
    /** 扩展速率预警值 mm/月：回归斜率 ≥ 该值判预警 */
    rateLimitMmPerMonth: 0.05,
    /** 预计超限窗口（天）：按当前速率推算在该窗口内超限即判预警 */
    warnDaysAhead: 90,
    /** 趋势判定最少样本数（宽度超限判定不受此限） */
    minSamples: 3,
    /** 关注档：缝宽达到限值的比例 */
    watchWidthFactor: 0.7,
    /** 关注档：速率达到预警值的比例 */
    watchRateFactor: 0.5,
  },

  /** 复核任务时限（小时）：P1 超限、P2 预警 */
  slaHours: { P1: 24, P2: 72 } as Record<string, number>,
};
