import { lineChart, sparkline, sectionStrip } from './charts.js';

// ---------- 基础工具 ----------
const $ = (sel) => document.querySelector(sel);

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const fmtTs = (ts) => `${fmtDate(ts)} ${pad2(new Date(ts).getHours())}:${pad2(new Date(ts).getMinutes())}`;
const fmtChainage = (m) => `K${Math.floor(m / 1000)}+${String(m % 1000).padStart(3, '0')}`;

const TREND = { stable: '稳定', growing: '缓慢扩展', accelerating: '加速扩展', insufficient: '数据不足', none: '无数据' };
const LEVEL = { normal: '正常', warning: '预警', critical: '超限', none: '无监测' };

const levelBadge = (l) => `<span class="badge lv-${l}">${LEVEL[l] || l}</span>`;
const trendBadge = (t) => `<span class="badge trend-${t}">${TREND[t] || t}</span>`;
const statusBadge = (s) => {
  const cls = { 待复核: 'pending', 复核中: 'doing', 已完成: 'done', 已闭环: 'closed', 监测中: 'done', 处置中: 'pending', 已闭合: 'closed' }[s] || '';
  return `<span class="badge st ${cls}">${s}</span>`;
};

function openModal(title, bodyHtml, { wide = false, onOk, okText = '确定' } = {}) {
  const wrap = $('#modal');
  wrap.innerHTML = `
    <div class="modal-mask"></div>
    <div class="modal-card${wide ? ' wide' : ''}">
      <h3>${title}</h3>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-actions">
        <button class="btn ghost" data-act="cancel">取消</button>
        ${onOk ? `<button class="btn" data-act="ok">${okText}</button>` : ''}
      </div>
    </div>`;
  const close = () => { wrap.innerHTML = ''; };
  wrap.querySelector('.modal-mask').addEventListener('click', close);
  wrap.querySelector('[data-act="cancel"]').addEventListener('click', close);
  if (onOk) {
    wrap.querySelector('[data-act="ok"]').addEventListener('click', async () => {
      try {
        const keep = await onOk(wrap.querySelector('.modal-body'));
        if (!keep) close();
      } catch (e) {
        toast(e.message, true);
      }
    });
  }
  return close;
}

// ---------- 路由 ----------
function parseHash() {
  const h = location.hash.slice(1) || '/dashboard';
  const [path, qs] = h.split('?');
  return { segs: path.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
}

async function render() {
  const { segs, query } = parseHash();
  const app = $('#app');
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === (segs[0] || 'dashboard'));
  });
  try {
    if (segs[0] === 'cracks') await renderCracks(app, query);
    else if (segs[0] === 'crack') await renderCrackDetail(app, segs[1]);
    else if (segs[0] === 'inspections') await renderInspections(app);
    else if (segs[0] === 'alarms') await renderAlarms(app);
    else if (segs[0] === 'tasks') await renderTasks(app);
    else if (segs[0] === 'gauges') await renderGauges(app);
    else await renderDashboard(app);
  } catch (e) {
    app.innerHTML = `<div class="empty">加载失败：${e.message}</div>`;
  }
}

// ---------- 总览 ----------
async function renderDashboard(app) {
  const ov = await api('/api/overview');
  $('#tunnel-sub').textContent = `${ov.tunnel.name} · ${ov.tunnel.line} ${ov.tunnel.direction} · ${fmtChainage(ov.tunnel.startM)}~${fmtChainage(ov.tunnel.endM)}`;
  const c = ov.counts;
  app.innerHTML = `
    <div class="page-title">总览看板 <span class="sub">${ov.tunnel.name} · 数据截至 ${fmtTs(Date.now())}</span></div>
    <div class="grid cols-4">
      <div class="card stat accent"><div class="num">${c.monitoring}</div><div class="lbl">监测中裂缝 / 共 ${c.cracks} 条</div></div>
      <div class="card stat crit"><div class="num">${c.alarmsCritical}</div><div class="lbl">超限告警（未闭环）</div></div>
      <div class="card stat warn"><div class="num">${c.alarmsWarning}</div><div class="lbl">预警告警（未闭环）</div></div>
      <div class="card stat ok"><div class="num">${c.tasksPending + c.tasksDoing}</div><div class="lbl">待办复核任务（已完成 ${c.tasksDone}）</div></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>段落健康图 <span class="more">每格 100m，点击查看该段裂缝</span></h3>
      <div id="strip"></div>
      <div class="legend">
        <span><i style="background:rgba(46,204,113,.5)"></i>正常</span>
        <span><i style="background:rgba(245,176,65,.7)"></i>预警</span>
        <span><i style="background:rgba(231,76,60,.8)"></i>超限</span>
        <span><i style="background:#212a34"></i>无监测裂缝</span>
      </div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <h3>扩展速率 TOP ${ov.topGrowing.length} <span class="more">近 30 天回归速率 mm/d</span></h3>
        <table class="tbl"><thead><tr><th>裂缝</th><th>里程</th><th>部位</th><th>速率</th><th>级别</th></tr></thead>
        <tbody>${ov.topGrowing.map((t) => `
          <tr>
            <td><a href="#/crack/${t.id}">${t.code}</a></td>
            <td class="num">${t.chainageLabel}</td><td>${t.position}</td>
            <td class="num">${t.rate.toFixed(4)}</td><td>${levelBadge(t.level)}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="empty">暂无数据</td></tr>'}</tbody></table>
      </div>
      <div class="card">
        <h3>最新告警 <span class="more"><a href="#/alarms" style="color:var(--accent)">全部 →</a></span></h3>
        <table class="tbl"><thead><tr><th>级别</th><th>裂缝</th><th>里程</th><th>状态</th><th>更新时间</th></tr></thead>
        <tbody>${ov.recentAlarms.map((a) => `
          <tr>
            <td>${levelBadge(a.level)}</td>
            <td><a href="#/crack/${a.crackId}">${a.crackCode}</a></td>
            <td class="num">${a.chainageLabel}</td>
            <td>${statusBadge(a.status)}</td>
            <td class="num">${fmtDate(a.updatedAt)}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="empty">暂无告警</td></tr>'}</tbody></table>
      </div>
    </div>`;
  sectionStrip($('#strip'), ov.sectionHealth, (s) => {
    location.hash = `#/cracks?sectionId=${s.sectionId}`;
  });
}

// ---------- 裂缝台账 ----------
async function renderCracks(app, query) {
  const [cracks, sections] = await Promise.all([api('/api/cracks'), api('/api/sections')]);
  const f = {
    sectionId: query.get('sectionId') || '',
    level: query.get('level') || '',
    trend: query.get('trend') || '',
  };
  const applyFilter = () => {
    const q = new URLSearchParams();
    if (f.sectionId) q.set('sectionId', f.sectionId);
    if (f.level) q.set('level', f.level);
    if (f.trend) q.set('trend', f.trend);
    location.hash = `#/cracks?${q}`;
  };
  const rows = cracks.filter((ck) =>
    (!f.sectionId || ck.sectionId === f.sectionId) &&
    (!f.level || ck.analysis?.level === f.level) &&
    (!f.trend || ck.analysis?.trend === f.trend));
  app.innerHTML = `
    <div class="page-title">裂缝台账 <span class="sub">${rows.length} / ${cracks.length} 条</span>
      <button class="btn sm" id="btn-new-crack" style="margin-left:auto">＋ 登记裂缝</button></div>
    <div class="filter-bar">
      <select id="f-sec"><option value="">全部段落</option>${sections.map((s) => `<option value="${s.id}" ${s.id === f.sectionId ? 'selected' : ''}>${s.code}</option>`).join('')}</select>
      <select id="f-level"><option value="">全部级别</option>${['normal', 'warning', 'critical'].map((l) => `<option value="${l}" ${l === f.level ? 'selected' : ''}>${LEVEL[l]}</option>`).join('')}</select>
      <select id="f-trend"><option value="">全部趋势</option>${Object.entries(TREND).filter(([k]) => k !== 'none').map(([k, v]) => `<option value="${k}" ${k === f.trend ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </div>
    <div class="card">
      <table class="tbl"><thead><tr>
        <th>编号</th><th>里程</th><th>部位</th><th>类型</th><th>当前宽度</th><th>速率 mm/d</th><th>加速度</th><th>趋势</th><th>级别</th><th>状态</th>
      </tr></thead><tbody>
      ${rows.map((ck) => {
        const a = ck.analysis || {};
        return `<tr>
          <td><a href="#/crack/${ck.id}">${ck.code}</a></td>
          <td class="num">${ck.chainageLabel}</td><td>${ck.position}</td><td>${ck.type}</td>
          <td class="num">${a.currentWidth != null ? a.currentWidth.toFixed(2) : '—'}</td>
          <td class="num" style="color:${a.rate > 0 ? 'var(--warn)' : 'inherit'}">${a.rate != null ? a.rate.toFixed(4) : '—'}</td>
          <td class="num">${a.accel != null ? a.accel.toFixed(4) : '—'}</td>
          <td>${a.trend ? trendBadge(a.trend) : '—'}</td>
          <td>${a.level ? levelBadge(a.level) : '—'}</td>
          <td>${statusBadge(ck.status)}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="10" class="empty">无匹配裂缝</td></tr>'}
      </tbody></table>
    </div>`;
  $('#f-sec').addEventListener('change', (e) => { f.sectionId = e.target.value; applyFilter(); });
  $('#f-level').addEventListener('change', (e) => { f.level = e.target.value; applyFilter(); });
  $('#f-trend').addEventListener('change', (e) => { f.trend = e.target.value; applyFilter(); });
  $('#btn-new-crack').addEventListener('click', () => openCrackForm(sections));
}

function openCrackForm(sections) {
  openModal('登记裂缝', `
    <label class="fld"><span>所在段落</span><select id="nc-sec">${sections.map((s) => `<option value="${s.id}">${s.code}</option>`).join('')}</select></label>
    <label class="fld"><span>里程（米，如 10320 表示 K10+320）</span><input id="nc-ch" type="number" placeholder="10320"></label>
    <label class="fld"><span>部位</span><select id="nc-pos">${['拱顶', '左拱腰', '右拱腰', '左边墙', '右边墙', '仰拱', '路面'].map((p) => `<option>${p}</option>`).join('')}</select></label>
    <label class="fld"><span>裂缝类型</span><select id="nc-type">${['纵向裂缝', '环向裂缝', '斜向裂缝', '网状裂缝'].map((p) => `<option>${p}</option>`).join('')}</select></label>
  `, {
    okText: '登记',
    onOk: async (body) => {
      await api('/api/cracks', 'POST', {
        sectionId: body.querySelector('#nc-sec').value,
        chainage: Number(body.querySelector('#nc-ch').value),
        position: body.querySelector('#nc-pos').value,
        type: body.querySelector('#nc-type').value,
      });
      toast('裂缝已登记');
      render();
    },
  });
}

// ---------- 裂缝详情 ----------
async function renderCrackDetail(app, id) {
  const [ck, cfg] = await Promise.all([api(`/api/cracks/${id}`), api('/api/config')]);
  const a = ck.analysis || {};
  const openAlarm = ck.alarms.find((al) => al.status !== '已闭环');
  app.innerHTML = `
    <div class="page-title">
      <a href="#/cracks" style="color:var(--muted)">←</a> ${ck.code}
      ${a.level ? levelBadge(a.level) : ''} ${a.trend ? trendBadge(a.trend) : ''} ${statusBadge(ck.status)}
      <span class="sub">${ck.chainageLabel} · ${ck.position} · ${ck.type} · 首见 ${fmtDate(ck.firstSeenAt)}</span>
    </div>
    <div class="kv">
      <div class="item"><div class="v">${a.currentWidth != null ? a.currentWidth.toFixed(2) : '—'}</div><div class="k">当前缝宽 mm（预警 ${cfg.thresholds.widthWarn} / 超限 ${cfg.thresholds.widthAlarm}）</div></div>
      <div class="item"><div class="v" style="color:${a.rate >= cfg.thresholds.rateAlarm ? 'var(--crit)' : a.rate >= cfg.thresholds.rateWarn ? 'var(--warn)' : 'inherit'}">${a.rate != null ? a.rate.toFixed(4) : '—'}</div><div class="k">近${cfg.thresholds.windowDays}天速率 mm/d（阈值 ${cfg.thresholds.rateAlarm}）</div></div>
      <div class="item"><div class="v">${a.accel != null ? a.accel.toFixed(4) : '—'}</div><div class="k">加速度（速率变化）mm/d</div></div>
      <div class="item"><div class="v">${a.r2 != null ? a.r2.toFixed(2) : '—'}</div><div class="k">回归拟合度 R²</div></div>
      <div class="item"><div class="v">${a.dayCount ?? '—'}</div><div class="k">监测天数 / ${a.sampleCount ?? 0} 条读数</div></div>
    </div>
    ${a.reasons?.length ? `<div class="card" style="border-color:var(--warn)"><b>超限原因</b><ul class="reason-list">${a.reasons.map((r) => `<li>${r}</li>`).join('')}</ul></div>` : ''}
    <div class="card" style="margin-top:14px">
      <h3>缝宽时序与趋势 <span class="more">蓝线=日均缝宽 · 紫虚线=近${cfg.thresholds.windowDays}天回归 · 虚线=阈值</span></h3>
      <div id="chart"></div>
    </div>
    <div class="grid cols-2" style="margin-top:14px">
      <div class="card">
        <h3>测缝计 ${ck.gauge ? `${ck.gauge.code}（${ck.gauge.type}）` : '未安装'}</h3>
        ${ck.gauge ? `
          <div class="muted" style="margin-bottom:10px">安装于 ${fmtDate(ck.gauge.installedAt)} · 状态 ${ck.gauge.status}</div>
          <div class="form-row">
            <label class="fld"><span>手动补录缝宽 mm</span><input id="rd-w" type="number" step="0.001" style="width:140px"></label>
            <button class="btn sm" id="rd-add">上报读数</button>
          </div>` : '<div class="empty">该裂缝未绑定测缝计</div>'}
        <h3 style="margin-top:14px">关联影像（${ck.images.length}）</h3>
        <div class="img-grid">${ck.images.map((im) => `
          <div class="img-card" data-img="${im.id}"><img src="${im.dataUrl}" alt=""><div class="cap">${im.fileName}<br>${fmtDate(im.createdAt)}</div></div>`).join('') || '<div class="empty">暂无影像</div>'}
        </div>
      </div>
      <div class="card">
        <h3>告警与复核
          ${openAlarm && !openAlarm.task ? `<button class="btn sm warn" id="btn-dispatch">派发复核任务</button>` : ''}
        </h3>
        ${ck.alarms.length ? ck.alarms.map((al) => `
          <div class="task-card">
            <div class="head"><b>${al.id}</b>${levelBadge(al.level)} ${statusBadge(al.status)}</div>
            <div class="meta">
              ${al.reasons.map((r) => `<div>· ${r}</div>`).join('')}
              <div>量值快照：宽 ${al.metrics.currentWidth?.toFixed(2)}mm，速率 ${al.metrics.rate?.toFixed(4)}mm/d</div>
              <div>${fmtTs(al.createdAt)}${al.closedAt ? ` → 闭环于 ${fmtTs(al.closedAt)}（${al.closure?.conclusion}）` : ''}</div>
              ${al.closure?.suggestion ? `<div>处置建议：${al.closure.suggestion}</div>` : ''}
            </div>
          </div>`).join('') : '<div class="empty">无告警记录</div>'}
        ${ck.tasks.length ? `<h3 style="margin-top:10px">复核任务</h3>` + ck.tasks.map((t) => `
          <div class="task-card">
            <div class="head"><b>${t.id}</b>${statusBadge(t.status)}</div>
            <div class="meta">复核人 ${t.assignee} · 期限 ${fmtDate(t.dueAt)}${t.result ? `<br>结论：${t.result.conclusion}，实测 ${t.result.measuredWidthMm}mm` : ''}</div>
          </div>`).join('') : ''}
      </div>
    </div>`;

  lineChart($('#chart'), {
    points: ck.series,
    warn: cfg.thresholds.widthWarn,
    alarm: cfg.thresholds.widthAlarm,
    reg: a.regression ? { ...a.regression, firstTs: a.firstTs } : null,
  });

  const rdBtn = $('#rd-add');
  if (rdBtn) {
    rdBtn.addEventListener('click', async () => {
      const w = Number($('#rd-w').value);
      if (!Number.isFinite(w) || w <= 0) return toast('请输入有效缝宽', true);
      await api(`/api/gauges/${ck.gauge.id}/readings`, 'POST', { widthMm: w });
      toast('读数已上报并重算趋势');
      render();
    });
  }
  const dispatchBtn = $('#btn-dispatch');
  if (dispatchBtn && openAlarm) {
    dispatchBtn.addEventListener('click', () => openDispatchForm(openAlarm.id, cfg.reviewers));
  }
  app.querySelectorAll('.img-card').forEach((el) => {
    el.addEventListener('click', async () => {
      const im = await api(`/api/images/${el.dataset.img}`);
      openImageViewer(im, ck);
    });
  });
}

function openDispatchForm(alarmId, reviewers) {
  openModal('派发现场复核任务', `
    <label class="fld"><span>复核人</span><select id="dp-user">${reviewers.map((r) => `<option>${r}</option>`).join('')}</select></label>
    <label class="fld"><span>要求完成期限（天）</span><input id="dp-days" type="number" value="3" min="1" max="30"></label>
    <label class="fld"><span>任务说明</span><textarea id="dp-note" rows="3" placeholder="现场复核要求、携带设备等"></textarea></label>
  `, {
    okText: '派发',
    onOk: async (body) => {
      await api(`/api/alarms/${alarmId}/dispatch`, 'POST', {
        assignee: body.querySelector('#dp-user').value,
        dueDays: Number(body.querySelector('#dp-days').value),
        note: body.querySelector('#dp-note').value,
      });
      toast('复核任务已派发');
      render();
    },
  });
}

function openImageViewer(im, ck) {
  const polys = (im.annotations || []).map((an) => {
    const pts = an.points.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="#ff5a4e" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  openModal(`${im.fileName}`, `
    <div class="annot-wrap">
      <img src="${im.dataUrl}">
      <svg class="annot-layer view" viewBox="0 0 100 100" preserveAspectRatio="none">${polys}</svg>
    </div>
    <div class="muted" style="margin-top:8px">${ck ? `关联裂缝：${ck.code} · ${ck.chainageLabel} ${ck.position}` : ''} · 采集于 ${fmtTs(im.createdAt)}</div>
  `, { wide: true });
}

// ---------- 巡检影像 ----------
async function renderInspections(app) {
  const [list, sections, cracks, cfg] = await Promise.all([
    api('/api/inspections'), api('/api/sections'), api('/api/cracks'), api('/api/config'),
  ]);
  app.innerHTML = `
    <div class="page-title">巡检影像 <span class="sub">${list.length} 次巡检</span>
      <button class="btn sm" id="btn-new-ins" style="margin-left:auto">＋ 新建巡检</button></div>
    ${list.map((ins) => `
      <div class="card" style="margin-bottom:14px">
        <h3>${fmtDate(ins.inspectedAt)} · ${ins.sectionCode} · ${ins.method}
          <span class="more">巡检人 ${ins.inspector} ${ins.note ? '· ' + ins.note : ''}</span>
          <button class="btn sm ghost" data-ins="${ins.id}">📤 上传影像</button>
        </h3>
        <div class="img-grid">${ins.images.map((im) => `
          <div class="img-card" data-img="${im.id}" data-crack="${im.crackId || ''}">
            <img src="${im.dataUrl}"><div class="cap">${im.fileName}</div>
          </div>`).join('') || '<div class="empty">本次巡检未上传影像</div>'}
        </div>
      </div>`).join('') || '<div class="empty">暂无巡检记录</div>'}`;

  $('#btn-new-ins').addEventListener('click', () => {
    openModal('新建巡检', `
      <label class="fld"><span>巡检段落</span><select id="ni-sec">${sections.map((s) => `<option value="${s.id}">${s.code}</option>`).join('')}</select></label>
      <label class="fld"><span>巡检人</span><select id="ni-user">${cfg.inspectors.map((p) => `<option>${p}</option>`).join('')}</select></label>
      <label class="fld"><span>方式</span><select id="ni-method">${['人工巡检', '车载巡检', '无人机巡检'].map((p) => `<option>${p}</option>`).join('')}</select></label>
      <label class="fld"><span>备注</span><input id="ni-note" placeholder="选填"></label>
    `, {
      okText: '创建',
      onOk: async (body) => {
        await api('/api/inspections', 'POST', {
          sectionId: body.querySelector('#ni-sec').value,
          inspector: body.querySelector('#ni-user').value,
          method: body.querySelector('#ni-method').value,
          note: body.querySelector('#ni-note').value,
        });
        toast('巡检已创建');
        render();
      },
    });
  });

  app.querySelectorAll('button[data-ins]').forEach((btn) => {
    btn.addEventListener('click', () => openUploader(btn.dataset.ins, cracks));
  });
  app.querySelectorAll('.img-card').forEach((el) => {
    el.addEventListener('click', async () => {
      const im = await api(`/api/images/${el.dataset.img}`);
      const ck = im.crackId ? cracks.find((c) => c.id === im.crackId) : null;
      openImageViewer(im, ck);
    });
  });
}

/** 上传影像：压缩 → 画布标注裂缝折线 → 关联裂缝 → 保存 */
function openUploader(inspectionId, cracks) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    openAnnotator(inspectionId, dataUrl, file.name, cracks);
  });
  input.click();
}

function fileToDataUrl(file, maxEdge = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s);
      cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      resolve(cv.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = URL.createObjectURL(file);
  });
}

function openAnnotator(inspectionId, dataUrl, fileName, cracks) {
  const points = [];
  openModal('标注裂缝走向（沿裂缝逐点点击）', `
    <div class="annot-wrap">
      <img src="${dataUrl}">
      <svg class="annot-layer" id="annot-svg" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
    </div>
    <div class="form-row" style="margin-top:10px">
      <label class="fld"><span>关联裂缝</span>
        <select id="an-crack" style="width:220px"><option value="">暂不关联</option>${cracks.map((c) => `<option value="${c.id}">${c.code} ${c.chainageLabel} ${c.position}</option>`).join('')}</select>
      </label>
      <button class="btn sm ghost" id="an-undo">撤销点</button>
      <button class="btn sm ghost" id="an-clear">清除</button>
      <span class="muted" id="an-count">已标 0 点</span>
    </div>
  `, {
    wide: true,
    okText: '保存影像',
    onOk: async (body) => {
      const crackId = body.querySelector('#an-crack').value || null;
      await api(`/api/inspections/${inspectionId}/images`, 'POST', {
        fileName,
        dataUrl,
        crackId,
        annotations: points.length >= 2 ? [{ crackId, points }] : [],
      });
      toast('影像已保存');
      render();
    },
  });
  const svg = $('#annot-svg');
  const redraw = () => {
    const pts = points.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');
    svg.innerHTML =
      (points.length >= 2 ? `<polyline points="${pts}" fill="none" stroke="#ff5a4e" stroke-width="2.5" vector-effect="non-scaling-stroke"/>` : '') +
      points.map(([x, y]) => `<circle cx="${x * 100}" cy="${y * 100}" r="1.2" fill="#ffde59" vector-effect="non-scaling-stroke" stroke-width="0"/>`).join('');
    $('#an-count').textContent = `已标 ${points.length} 点`;
  };
  svg.addEventListener('click', (e) => {
    const r = svg.getBoundingClientRect();
    points.push([
      Math.round(((e.clientX - r.left) / r.width) * 10000) / 10000,
      Math.round(((e.clientY - r.top) / r.height) * 10000) / 10000,
    ]);
    redraw();
  });
  $('#an-undo').addEventListener('click', () => { points.pop(); redraw(); });
  $('#an-clear').addEventListener('click', () => { points.length = 0; redraw(); });
}

// ---------- 告警中心 ----------
async function renderAlarms(app) {
  const [alarms, cfg] = await Promise.all([api('/api/alarms'), api('/api/config')]);
  const t = cfg.thresholds;
  app.innerHTML = `
    <div class="page-title">告警中心 <span class="sub">未闭环 ${alarms.filter((a) => a.status !== '已闭环').length} 条</span></div>
    <div class="card" style="margin-bottom:14px">
      <h3>超限判定规则 <span class="more">调整后自动全量重算</span></h3>
      <div class="form-row">
        <label class="fld"><span>宽度预警 mm</span><input id="th-ww" type="number" step="0.05" value="${t.widthWarn}" style="width:100px"></label>
        <label class="fld"><span>宽度超限 mm</span><input id="th-wa" type="number" step="0.05" value="${t.widthAlarm}" style="width:100px"></label>
        <label class="fld"><span>速率预警 mm/d</span><input id="th-rw" type="number" step="0.001" value="${t.rateWarn}" style="width:100px"></label>
        <label class="fld"><span>速率超限 mm/d</span><input id="th-ra" type="number" step="0.001" value="${t.rateAlarm}" style="width:100px"></label>
        <label class="fld"><span>趋势窗口（天）</span><input id="th-win" type="number" step="1" value="${t.windowDays}" style="width:80px"></label>
        <button class="btn sm" id="th-save">保存并重算</button>
      </div>
    </div>
    <div class="card">
      <table class="tbl"><thead><tr>
        <th>告警</th><th>级别</th><th>裂缝</th><th>里程/部位</th><th>超限原因</th><th>量值快照</th><th>状态</th><th>操作</th>
      </tr></thead><tbody>
      ${alarms.map((a) => `
        <tr>
          <td class="num">${a.id}</td>
          <td>${levelBadge(a.level)}</td>
          <td><a href="#/crack/${a.crackId}">${a.crackCode}</a></td>
          <td class="num">${a.chainageLabel}<br><span class="muted">${a.position}</span></td>
          <td><ul class="reason-list">${a.reasons.map((r) => `<li>${r}</li>`).join('')}</ul></td>
          <td class="num">宽 ${a.metrics.currentWidth?.toFixed(2)}mm<br>速 ${a.metrics.rate?.toFixed(4)}mm/d</td>
          <td>${statusBadge(a.status)}${a.task ? `<br><span class="muted" style="font-size:11px">任务 ${a.task.id}</span>` : ''}</td>
          <td>${a.status !== '已闭环' && !a.task ? `<button class="btn sm warn" data-dispatch="${a.id}">派发复核</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="empty">暂无告警</td></tr>'}
      </tbody></table>
    </div>`;
  $('#th-save').addEventListener('click', async () => {
    const r = await api('/api/config/thresholds', 'PUT', {
      widthWarn: Number($('#th-ww').value),
      widthAlarm: Number($('#th-wa').value),
      rateWarn: Number($('#th-rw').value),
      rateAlarm: Number($('#th-ra').value),
      windowDays: Number($('#th-win').value),
    });
    toast(`阈值已保存，重算：新建告警 ${r.reevaluated.created}，更新 ${r.reevaluated.updated}`);
    render();
  });
  app.querySelectorAll('[data-dispatch]').forEach((btn) => {
    btn.addEventListener('click', () => openDispatchForm(btn.dataset.dispatch, cfg.reviewers));
  });
}

// ---------- 复核任务 ----------
async function renderTasks(app) {
  const tasks = await api('/api/tasks');
  const cols = [
    { key: '待复核', title: '待复核（已派发未接单）' },
    { key: '复核中', title: '复核中（已接单）' },
    { key: '已完成', title: '已完成' },
  ];
  const card = (t) => `
    <div class="task-card ${t.overdue ? 'overdue' : ''}">
      <div class="head"><b>${t.id}</b><span>${levelBadge(t.alarmLevel || 'normal')} ${t.priority ? `<span class="badge">${t.priority}优先级</span>` : ''}</span></div>
      <div class="meta">
        <div><a href="#/crack/${t.crackId}">${t.crackCode}</a> · ${t.chainageLabel} ${t.position} · ${t.crackType}</div>
        ${(t.alarmReasons || []).map((r) => `<div>· ${r}</div>`).join('')}
        ${t.metrics ? `<div>派单量值：宽 ${t.metrics.currentWidth?.toFixed(2)}mm，速率 ${t.metrics.rate?.toFixed(4)}mm/d</div>` : ''}
        <div>复核人：${t.assignee} · 期限 ${fmtDate(t.dueAt)} ${t.overdue ? '<span class="overdue-tag">已逾期</span>' : ''}</div>
        ${t.note ? `<div>说明：${t.note}</div>` : ''}
        ${t.result ? `<div style="color:var(--ok)">结论：${t.result.conclusion} · 实测 ${t.result.measuredWidthMm}mm${t.result.suggestion ? `<br>建议：${t.result.suggestion}` : ''}</div>` : ''}
      </div>
      <div class="actions">
        ${t.status === '待复核' ? `<button class="btn sm" data-claim="${t.id}">接单</button>` : ''}
        ${t.status === '复核中' ? `<button class="btn sm" data-complete="${t.id}">提交复核结果</button>` : ''}
      </div>
    </div>`;
  app.innerHTML = `
    <div class="page-title">现场复核任务 <span class="sub">超限段落 → 派发 → 接单 → 现场复核 → 结论回填闭环</span></div>
    <div class="kanban">
      ${cols.map((c) => `
        <div class="kanban-col"><h3>${c.title}（${tasks.filter((t) => t.status === c.key).length}）</h3>
        ${tasks.filter((t) => t.status === c.key).map(card).join('') || '<div class="empty">空</div>'}</div>`).join('')}
    </div>`;
  app.querySelectorAll('[data-claim]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/tasks/${btn.dataset.claim}/claim`, 'POST', {});
      toast('已接单，请赴现场复核');
      render();
    });
  });
  app.querySelectorAll('[data-complete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = tasks.find((x) => x.id === btn.dataset.complete);
      openModal(`提交复核结果 · ${t.id}（${t.crackCode} ${t.chainageLabel}）`, `
        <label class="fld"><span>现场实测缝宽 mm</span><input id="cp-w" type="number" step="0.01" placeholder="如 0.52"></label>
        <label class="fld"><span>复核结论</span><select id="cp-c">
          <option>确认扩展</option><option>稳定</option><option>误报</option>
        </select></label>
        <label class="fld"><span>处置建议</span><textarea id="cp-s" rows="3" placeholder="如：建议注浆加固 / 继续监测 / 加密观测频次"></textarea></label>
        <div class="muted" style="font-size:12px">结论「确认扩展」→ 裂缝转处置中；「误报」→ 告警闭合并静默 7 天；「稳定」→ 继续监测。</div>
      `, {
        okText: '提交并闭环',
        onOk: async (body) => {
          await api(`/api/tasks/${t.id}/complete`, 'POST', {
            measuredWidthMm: Number(body.querySelector('#cp-w').value),
            conclusion: body.querySelector('#cp-c').value,
            suggestion: body.querySelector('#cp-s').value,
          });
          toast('复核结果已提交，告警闭环');
          render();
        },
      });
    });
  });
}

// ---------- 测缝计 ----------
async function renderGauges(app) {
  const gauges = await api('/api/gauges');
  app.innerHTML = `
    <div class="page-title">测缝计数据接入 <span class="sub">${gauges.length} 台设备</span></div>
    <div class="card" style="margin-bottom:14px">
      <h3>物联网关对接（批量上报）</h3>
      <pre class="code">curl -X POST http://localhost:8080/api/readings/batch \\
  -H 'Content-Type: application/json' \\
  -d '{"readings":[{"gaugeCode":"CG-001","widthMm":0.523,"temperature":18.5}]}'</pre>
      <div class="muted" style="font-size:12px">同一设备同一天重复上报自动覆盖（幂等）；上报后系统自动重算趋势与告警。</div>
    </div>
    <div class="card">
      <table class="tbl"><thead><tr>
        <th>设备编号</th><th>类型</th><th>关联裂缝</th><th>里程</th><th>状态</th><th>最近读数</th><th>读数时间</th>
      </tr></thead><tbody>
      ${gauges.map((g) => `
        <tr>
          <td class="num">${g.code}</td><td>${g.type}</td>
          <td><a href="#/crack/${g.crackId}">${g.crackCode}</a></td>
          <td class="num">${g.chainageLabel}</td>
          <td>${statusBadge(g.status)}</td>
          <td class="num">${g.lastReading ? g.lastReading.widthMm.toFixed(3) + ' mm' : '—'}</td>
          <td class="num">${g.lastReading ? fmtTs(g.lastReading.ts) : '—'}</td>
        </tr>`).join('')}
      </tbody></table>
    </div>`;
}

// ---------- 顶栏动作 ----------
$('#btn-simulate').addEventListener('click', async () => {
  const r = await api('/api/simulate/day', 'POST', {});
  toast(`已生成 ${r.created} 条读数；新建告警 ${r.alarms.created}，更新 ${r.alarms.updated}`);
  render();
});
$('#btn-reanalyze').addEventListener('click', async () => {
  const r = await api('/api/analysis/run', 'POST', {});
  toast(`重算完成：新建告警 ${r.created}，更新 ${r.updated}，自动派发 ${r.tasksCreated}`);
  render();
});

window.addEventListener('hashchange', render);
render();
