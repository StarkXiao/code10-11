import { describe, expect, it } from 'vitest';
import { assessTrend, linearRegression, type AssessLimits } from '../src/analysis/trend.js';

const LIMITS: AssessLimits = {
  widthLimitMm: 0.2,
  rateLimitMmPerMonth: 0.05,
  warnDaysAhead: 90,
  minSamples: 3,
  watchWidthFactor: 0.7,
  watchRateFactor: 0.5,
};

const NOW = new Date('2026-09-22T00:00:00Z');

/** 生成每月一次的观测序列：width = base + rate * 月数 */
function series(base: number, rate: number, months: number) {
  const pts = [];
  for (let i = 0; i < months; i++) {
    const t = new Date(NOW.getTime() - (months - 1 - i) * 30.4375 * 86_400_000);
    pts.push({ observedAt: t.toISOString(), widthMm: Number((base + rate * i).toFixed(3)) });
  }
  return pts;
}

describe('linearRegression', () => {
  it('完美直线：斜率/截距/R² 精确还原', () => {
    const reg = linearRegression([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(reg.slope).toBeCloseTo(2);
    expect(reg.intercept).toBeCloseTo(1);
    expect(reg.rSquared).toBeCloseTo(1);
  });

  it('常数序列：斜率 0、R²=1', () => {
    const reg = linearRegression([0, 1, 2], [0.1, 0.1, 0.1]);
    expect(reg.slope).toBe(0);
    expect(reg.rSquared).toBe(1);
  });

  it('x 全部相同（同一时刻重复观测）：斜率按 0 处理不抛错', () => {
    const reg = linearRegression([5, 5, 5], [0.1, 0.2, 0.3]);
    expect(reg.slope).toBe(0);
  });
});

describe('assessTrend 分级', () => {
  it('无数据 → insufficient_data', () => {
    const r = assessTrend([], LIMITS, NOW);
    expect(r.level).toBe('insufficient_data');
  });

  it('样本不足且未超限 → insufficient_data', () => {
    const r = assessTrend(series(0.1, 0.01, 2), LIMITS, NOW);
    expect(r.level).toBe('insufficient_data');
    expect(r.sampleCount).toBe(2);
  });

  it('样本不足但缝宽已超限 → exceeded（超限判定不依赖样本量）', () => {
    const r = assessTrend([{ observedAt: NOW.toISOString(), widthMm: 0.25 }], LIMITS, NOW);
    expect(r.level).toBe('exceeded');
  });

  it('缝宽达到限值 → exceeded，并给出仍在发展的提示', () => {
    const r = assessTrend(series(0.05, 0.04, 6), LIMITS, NOW); // 最新 0.25
    expect(r.level).toBe('exceeded');
    expect(r.latestWidthMm).toBeCloseTo(0.25);
    expect(r.reasons.join()).toContain('超限');
  });

  it('速率 ≥ 预警值 → warning', () => {
    const r = assessTrend(series(0.02, 0.06, 6), LIMITS, NOW); // 最新 0.32? 0.02+0.3=0.32 → exceeded
    // 0.02 + 0.06*5 = 0.32 ≥ 0.2，实际为 exceeded；改用更低基数
    expect(['exceeded', 'warning']).toContain(r.level);
    const r2 = assessTrend(series(0.0, 0.06, 3), LIMITS, NOW); // 最新 0.12，速率 0.06
    expect(r2.level).toBe('warning');
    expect(r2.slopeMmPerMonth).toBeCloseTo(0.06, 3);
    expect(r2.reasons.join()).toContain('速率');
  });

  it('速率不高但预计窗口内超限 → warning', () => {
    // 最新 0.17，限值 0.2，速率 0.03mm/月 → 约 1 个月后超限 < 90 天窗口
    const r = assessTrend(series(0.11, 0.03, 3), LIMITS, NOW);
    expect(r.level).toBe('warning');
    expect(r.daysToExceed).toBeGreaterThan(0);
    expect(r.daysToExceed!).toBeLessThanOrEqual(90);
    expect(r.predictedExceedAt).not.toBeNull();
  });

  it('缝宽 ≥ 限值 70% → watch', () => {
    const r = assessTrend(series(0.15, 0.0, 4), LIMITS, NOW); // 0.15 ≥ 0.14
    expect(r.level).toBe('watch');
  });

  it('速率达到预警值一半 → watch', () => {
    const r = assessTrend(series(0.02, 0.03, 4), LIMITS, NOW); // 速率 0.03 ≥ 0.025，最新 0.11
    expect(r.level).toBe('watch');
  });

  it('稳定小缝宽 → normal', () => {
    const r = assessTrend(series(0.08, 0.001, 6), LIMITS, NOW);
    expect(r.level).toBe('normal');
  });

  it('裂缝趋于闭合（负斜率）→ normal', () => {
    const r = assessTrend(series(0.12, -0.01, 5), LIMITS, NOW);
    expect(r.level).toBe('normal');
    expect(r.slopeMmPerMonth!).toBeLessThan(0);
    expect(r.daysToExceed).toBeNull();
  });

  it('预计超限时间：斜率与剩余量可复算', () => {
    // base 0.1, rate 0.04/月, 3 个点 → 最新 0.18，距限值 0.02mm → 0.5 月 ≈ 15.2 天
    const r = assessTrend(series(0.1, 0.04, 3), LIMITS, NOW);
    expect(r.daysToExceed).toBeCloseTo(15.2, 0);
  });
});
