/**
 * 裂缝扩展趋势分析（纯函数模块，不依赖数据库）。
 *
 * 输入：某条裂缝的宽度观测序列（测缝计 / 影像识别 / 人工量测统一归集）。
 * 输出：风险分级 + 人读理由 + 量化指标（回归斜率、R²、预计超限时间）。
 *
 * 判定口径：
 *  - 超限 exceeded：最新缝宽 ≥ 宽度限值（只看当前值，不依赖样本量）；
 *  - 预警 warning：扩展速率 ≥ 预警值，或按当前速率推算在预警窗口内超限；
 *  - 关注 watch：速率达到预警值一半，或缝宽达到限值 70%；
 *  - 样本不足 insufficient_data：观测点少于 minSamples 且未超限。
 */

export interface TrendPoint {
  observedAt: string; // ISO 时间
  widthMm: number;
}

export interface AssessLimits {
  widthLimitMm: number;
  rateLimitMmPerMonth: number;
  warnDaysAhead: number;
  minSamples: number;
  watchWidthFactor: number;
  watchRateFactor: number;
}

export type RiskLevel = 'exceeded' | 'warning' | 'watch' | 'normal' | 'insufficient_data';

export interface TrendAssessment {
  level: RiskLevel;
  reasons: string[];
  sampleCount: number;
  spanDays: number;
  latestWidthMm: number | null;
  latestAt: string | null;
  /** 回归斜率（mm/月），负值表示裂缝趋于闭合 */
  slopeMmPerMonth: number | null;
  rSquared: number | null;
  /** 按当前速率推算的超限剩余天数（仅斜率 > 0 且尚未超限时给出） */
  daysToExceed: number | null;
  predictedExceedAt: string | null;
}

export const DAYS_PER_MONTH = 30.4375;
const MS_PER_DAY = 86_400_000;

/** 最小二乘线性回归。x 全相同（同一时刻多次观测）时斜率按 0 处理。 */
export function linearRegression(xs: number[], ys: number[]) {
  const n = xs.length;
  if (n === 0) return { slope: 0, intercept: 0, rSquared: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  // 所有 y 相同（在浮点容差内）：完全拟合。ssTot 需按 y 的量纲放容差，
  // 否则常数序列的 ssTot 是 1e-35 量级而非 0，R² 会被浮点噪声带偏。
  const tol = 1e-12 * n * Math.max(1, my * my);
  const rSquared = ssTot <= tol ? (ssRes <= tol ? 1 : 0) : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, rSquared };
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));

export function assessTrend(
  points: TrendPoint[],
  limits: AssessLimits,
  now: Date = new Date(),
): TrendAssessment {
  const sorted = [...points].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const n = sorted.length;

  const result: TrendAssessment = {
    level: 'insufficient_data',
    reasons: [],
    sampleCount: n,
    spanDays: 0,
    latestWidthMm: null,
    latestAt: null,
    slopeMmPerMonth: null,
    rSquared: null,
    daysToExceed: null,
    predictedExceedAt: null,
  };
  if (n === 0) {
    result.reasons.push('暂无观测数据');
    return result;
  }

  const latest = sorted[n - 1];
  result.latestWidthMm = latest.widthMm;
  result.latestAt = latest.observedAt;

  // 趋势拟合：≥2 个点即可给出斜率，但分级判定要求 ≥ minSamples
  if (n >= 2) {
    const t0 = Date.parse(sorted[0].observedAt);
    const tN = Date.parse(latest.observedAt);
    result.spanDays = round((tN - t0) / MS_PER_DAY, 1);
    const xs = sorted.map((p) => (Date.parse(p.observedAt) - t0) / (DAYS_PER_MONTH * MS_PER_DAY));
    const ys = sorted.map((p) => p.widthMm);
    const reg = linearRegression(xs, ys);
    result.slopeMmPerMonth = round(reg.slope, 4);
    result.rSquared = round(reg.rSquared, 3);

    if (reg.slope > 0 && latest.widthMm < limits.widthLimitMm) {
      const days = ((limits.widthLimitMm - latest.widthMm) / reg.slope) * DAYS_PER_MONTH;
      result.daysToExceed = round(days, 1);
      result.predictedExceedAt = new Date(now.getTime() + days * MS_PER_DAY).toISOString();
    }
  }

  // 超限：只看当前缝宽，样本不足也判
  if (latest.widthMm >= limits.widthLimitMm) {
    result.level = 'exceeded';
    result.reasons.push(
      `当前缝宽 ${latest.widthMm}mm ≥ 限值 ${limits.widthLimitMm}mm，判定超限`,
    );
    if (result.slopeMmPerMonth !== null && result.slopeMmPerMonth > 0) {
      result.reasons.push(`扩展速率 ${result.slopeMmPerMonth}mm/月，仍在发展`);
    }
    return result;
  }

  if (n < limits.minSamples) {
    result.reasons.push(`观测样本 ${n} 条 < ${limits.minSamples} 条，暂不做趋势判定`);
    return result;
  }

  const rate = Math.max(0, result.slopeMmPerMonth ?? 0);
  const hitRateLimit = rate >= limits.rateLimitMmPerMonth;
  const hitWindow = result.daysToExceed !== null && result.daysToExceed <= limits.warnDaysAhead;

  if (hitRateLimit || hitWindow) {
    result.level = 'warning';
    if (hitRateLimit) {
      result.reasons.push(
        `扩展速率 ${result.slopeMmPerMonth}mm/月 ≥ 预警值 ${limits.rateLimitMmPerMonth}mm/月`,
      );
    }
    if (hitWindow) {
      result.reasons.push(
        `按当前速率预计 ${result.daysToExceed} 天后超限（预警窗口 ${limits.warnDaysAhead} 天）`,
      );
    }
    return result;
  }

  if (
    rate >= limits.rateLimitMmPerMonth * limits.watchRateFactor ||
    latest.widthMm >= limits.widthLimitMm * limits.watchWidthFactor
  ) {
    result.level = 'watch';
    result.reasons.push(
      `缝宽 ${latest.widthMm}mm / 速率 ${result.slopeMmPerMonth}mm/月，接近限值，列入关注`,
    );
    return result;
  }

  result.level = 'normal';
  result.reasons.push('缝宽与扩展速率均在限值内');
  return result;
}
