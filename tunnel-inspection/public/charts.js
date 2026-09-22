/** 轻量 SVG 图表：时序折线（含阈值线/回归线）、迷你走势、段落健康条带 */

const DAY = 86400000;

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const fmtDate = (ts) => {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * 缝宽时序图
 * points: [{ts, width}]；warn/alarm: 阈值横线；reg: {a,b,fromX,toX,firstTs} 回归线
 */
export function lineChart(container, { points, warn, alarm, reg, height = 320 }) {
  container.innerHTML = '';
  const W = Math.max(container.clientWidth || 760, 480);
  const H = height;
  const pad = { l: 56, r: 16, t: 16, b: 34 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const svg = svgEl('svg', { width: W, height: H, class: 'chart' });
  if (!points.length) {
    const t = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#8a97a5', 'font-size': 14 });
    t.textContent = '暂无读数数据';
    svg.appendChild(t);
    container.appendChild(svg);
    return;
  }

  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.width);
  let yMax = Math.max(...ys, alarm || 0, warn || 0) * 1.15;
  let yMin = Math.min(...ys, warn ?? Infinity) * 0.85;
  if (yMin < 0) yMin = 0;
  if (yMax - yMin < 0.05) yMax = yMin + 0.05;
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const X = (ts) => pad.l + ((ts - xMin) / Math.max(1, xMax - xMin)) * iw;
  const Y = (v) => pad.t + ih - ((v - yMin) / (yMax - yMin)) * ih;

  // 网格与坐标轴
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i += 1) {
    const v = yMin + ((yMax - yMin) * i) / yTicks;
    const y = Y(v);
    svg.appendChild(svgEl('line', { x1: pad.l, y1: y, x2: W - pad.r, y2: y, stroke: '#26303c', 'stroke-width': 1 }));
    const t = svgEl('text', { x: pad.l - 8, y: y + 4, 'text-anchor': 'end', fill: '#8a97a5', 'font-size': 11 });
    t.textContent = v.toFixed(2);
    svg.appendChild(t);
  }
  const xTicks = Math.min(8, points.length);
  for (let i = 0; i <= xTicks; i += 1) {
    const ts = xMin + ((xMax - xMin) * i) / xTicks;
    const x = X(ts);
    const t = svgEl('text', { x, y: H - 10, 'text-anchor': 'middle', fill: '#8a97a5', 'font-size': 11 });
    t.textContent = fmtDate(ts);
    svg.appendChild(t);
  }
  const yLabel = svgEl('text', { x: 14, y: pad.t + ih / 2, fill: '#8a97a5', 'font-size': 11, transform: `rotate(-90 14 ${pad.t + ih / 2})`, 'text-anchor': 'middle' });
  yLabel.textContent = '缝宽 mm';
  svg.appendChild(yLabel);

  // 阈值线
  const threshold = (v, color, label) => {
    if (v == null) return;
    const y = Y(v);
    svg.appendChild(svgEl('line', { x1: pad.l, y1: y, x2: W - pad.r, y2: y, stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': '7 5' }));
    const t = svgEl('text', { x: W - pad.r - 4, y: y - 5, 'text-anchor': 'end', fill: color, 'font-size': 11 });
    t.textContent = label;
    svg.appendChild(t);
  };
  threshold(warn, '#f5b041', `预警 ${warn}mm`);
  threshold(alarm, '#e74c3c', `超限 ${alarm}mm`);

  // 回归线（近 N 天趋势）
  if (reg) {
    const ts1 = reg.firstTs + reg.fromX * DAY;
    const ts2 = reg.firstTs + reg.toX * DAY;
    svg.appendChild(svgEl('line', {
      x1: X(ts1), y1: Y(reg.a + reg.b * reg.fromX),
      x2: X(ts2), y2: Y(reg.a + reg.b * reg.toX),
      stroke: '#c678dd', 'stroke-width': 2, 'stroke-dasharray': '3 4',
    }));
  }

  // 数据折线
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.ts).toFixed(1)},${Y(p.width).toFixed(1)}`).join(' ');
  svg.appendChild(svgEl('path', { d, fill: 'none', stroke: '#4fc3f7', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  const last = points[points.length - 1];
  svg.appendChild(svgEl('circle', { cx: X(last.ts), cy: Y(last.width), r: 4, fill: '#4fc3f7', stroke: '#0f1419', 'stroke-width': 2 }));

  // 悬浮读数
  const tip = svgEl('g', { visibility: 'hidden' });
  const tipLine = svgEl('line', { y1: pad.t, y2: pad.t + ih, stroke: '#54606e', 'stroke-width': 1 });
  const tipDot = svgEl('circle', { r: 4, fill: '#fff' });
  const tipText = svgEl('text', { fill: '#e8eef4', 'font-size': 11 });
  tip.append(tipLine, tipDot, tipText);
  svg.appendChild(tip);
  svg.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = null;
    let bd = Infinity;
    for (const p of points) {
      const dd = Math.abs(X(p.ts) - mx);
      if (dd < bd) { bd = dd; best = p; }
    }
    if (!best) return;
    tip.setAttribute('visibility', 'visible');
    tipLine.setAttribute('x1', X(best.ts)); tipLine.setAttribute('x2', X(best.ts));
    tipDot.setAttribute('cx', X(best.ts)); tipDot.setAttribute('cy', Y(best.width));
    tipText.setAttribute('x', Math.min(X(best.ts) + 8, W - 130)); tipText.setAttribute('y', pad.t + 14);
    tipText.textContent = `${fmtDate(best.ts)}  ${best.width.toFixed(3)}mm`;
  });
  svg.addEventListener('mouseleave', () => tip.setAttribute('visibility', 'hidden'));

  container.appendChild(svg);
}

/** 迷你走势（表格行内） */
export function sparkline(values, { width = 96, height = 26, color = '#4fc3f7' } = {}) {
  if (!values.length) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / Math.max(1, values.length - 1)) * (width - 4) + 2).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`)
    .join(' ');
  return `<svg width="${width}" height="${height}" class="spark"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`;
}

/** 段落健康条带：按里程排列的色块 */
export function sectionStrip(container, sections, onSelect) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'strip';
  for (const s of sections) {
    const cell = document.createElement('div');
    cell.className = `strip-cell lv-${s.level}`;
    cell.title = `${s.code}  ${s.crackCount ? `${s.crackCount} 条裂缝` : '无监测裂缝'}`;
    cell.textContent = s.crackCount || '';
    cell.addEventListener('click', () => onSelect && onSelect(s));
    wrap.appendChild(cell);
  }
  container.appendChild(wrap);
}
