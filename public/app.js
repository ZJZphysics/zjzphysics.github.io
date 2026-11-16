const panel = document.querySelector('#panel');
const notice = document.querySelector('#notice');
const identity = document.querySelector('#identity');
let state = null;
let busy = false;
let tab = '';
let refreshId = 0;

const labels = { pending: '待开放', open: '评分中', closed: '已结束' };
const pages = new Set(['overview', 'score', 'materials', 'admin']);
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const groupName = id => `第 ${id} 组`;
const studentCaption = user => `${escape(user.id)} · ${user.group_id == null ? '待分组' : groupName(user.group_id)}`;
const openGroup = () => state.groups.find(group => group.state === 'open');
const status = group => `<span class="status ${group.state}">${labels[group.state]}</span>`;
const result = value => value == null ? '—' : Number(value).toFixed(2);
const button = (label, attrs = '', style = '') => `<button class="button ${style}" ${attrs}>${label}</button>`;
const heading = (title, subtitle, actions = '') => `<div class="section-heading"><div><h2 tabindex="-1">${title}</h2>${subtitle ? `<p class="muted">${subtitle}</p>` : ''}</div>${actions}</div>`;

async function request(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('暂时无法读取课程服务。请稍后刷新。');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败，请重试。');
  return data;
}

function write(path, data) {
  return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

function message(value, error = false) {
  notice.textContent = value;
  notice.hidden = !value;
  notice.classList.toggle('error', error);
}

async function refresh(force = false) {
  const current = ++refreshId;
  const next = await request('/api/state');
  if (current !== refreshId) return;
  if (force || JSON.stringify(state) !== JSON.stringify(next)) {
    state = next;
    render();
  }
}

function loginForm(admin = false) {
  return `<div class="panel-card">
    <h3>${admin ? '管理员登录' : '学生登录'}</h3>
    ${admin ? '' : '<p class="muted">输入课程名单中的学号，字母大小写均可。</p>'}
    <form data-form="login" data-admin="${admin}" class="form-grid">
      ${admin ? '<label>管理员密码<input name="secret" type="password" autocomplete="current-password" maxlength="40" required></label>'
        : '<label>学号<input name="studentId" type="text" autocomplete="username" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="例如 SY2600001" required></label>'}
      <div>${button('登录', 'type="submit"')}</div>
    </form>
  </div>`;
}

function overviewPage() {
  const active = openGroup();
  const finished = state.groups.filter(group => group.state === 'closed').length;
  const groups = state.groups.map(group => `<article class="group-card ${group.state === 'open' ? 'current' : ''}">
    <div class="group-head"><h3 class="group-index">${groupName(group.id)}</h3>${status(group)}</div>
    ${group.title ? `<p>${escape(group.title)}</p>` : ''}
    <p class="muted">${group.average != null ? `小组均分 <strong class="grade">${result(group.average)}</strong>` : group.state === 'open' ? '可提交本轮评分' : group.deck_name || group.pdf_name ? '已提交课件' : group.state === 'closed' ? '本轮评分已结束' : '等待本组汇报'}</p>
  </article>`).join('');
  const overall = state.overall != null ? `<p class="metric">全班总平均 <strong>${result(state.overall)}</strong></p>` : '';
  return `${heading('汇报进度', `${finished} / 8 组已结束评分`, button('刷新进度', 'data-action="refresh"', 'secondary small'))}
    <div class="overview"><div class="group-grid">${groups}</div><aside aria-label="评分流程">
    <article class="side-card primary"><h3>${active ? `${groupName(active.id)}评分中` : finished === 8 ? '八组评分已结束' : '等待开放评分'}</h3>
    ${overall || `<p class="muted">${active ? '其他组同学可实名提交一份评分。' : finished === 8 ? '成绩发布后，课程成员可查看汇总。' : '每组汇报结束后，管理员开放对应轮次。'}</p>`}
    <div class="progress" aria-label="${finished} 组已结束">${state.groups.map(group => `<span class="${group.state === 'closed' ? 'finished' : ''}"></span>`).join('')}</div>
    ${active ? '<a class="button small" href="#score">前往本轮评分 <span aria-hidden="true">→</span></a>' : ''}</article>
    <article class="side-card"><h3>评分流程</h3><ol><li>输入学号登录</li><li>每轮独立提交一次百分制评分</li><li>系统按名册自动跳过自己的组</li></ol></article></aside></div>`;
}

function scorePage() {
  const start = '<div class="subview narrow">' + heading('实名评分', '每组汇报结束后开放一轮。');
  if (!state.user) return start + loginForm() + '</div>';
  if (state.user.role === 'admin') return `${start}<div class="panel-card"><p>你当前使用管理员身份。</p><a class="text-link" href="#admin">管理评分轮次</a></div></div>`;
  const student = state.user;
  const group = openGroup();
  const score = group && state.mine.find(item => item.group_id === group.id);
  let current;
  if (student.group_id == null) current = '<h3>待分组</h3><p class="muted">管理员为你分组后，即可参与评分。</p>';
  else if (!group) current = '<h3>暂无开放的评分轮次</h3><p class="muted">本轮开放后，页面会自动更新。你也可以手动刷新。</p>';
  else if (group.id === student.group_id) current = `<h3>${groupName(group.id)}正在评分</h3><p class="muted">这是你所在的小组，本轮已为你跳过。</p>`;
  else if (score) current = `<h3>${groupName(group.id)}已提交</h3><p>你的评分为 <strong class="grade">${score.value}</strong> 分。</p>`;
  else current = `<h3>为${groupName(group.id)}评分</h3>${group.title ? `<p>${escape(group.title)}</p>` : ''}<p class="muted">请综合考虑研究内容、物理推导和汇报表达。评分提交后即锁定。</p>
    <form class="form-grid" data-form="score" data-group="${group.id}"><label class="score-input">总分（0–100）<input name="score" type="number" inputmode="numeric" min="0" max="100" step="1" placeholder="请输入整数" required></label><div>${button('提交本轮评分', 'type="submit"')}</div></form>`;
  const history = state.mine.map(item => `<li><span>${groupName(item.group_id)}</span><span class="grade">${item.value} 分</span></li>`).join('');
  return `${start}<div class="panel-card"><p class="muted identity-line">${studentCaption(student)}</p>${current}</div>
    ${history ? `<div class="panel-card"><h3>我的评分记录</h3><ul class="list">${history}</ul></div>` : ''}</div>`;
}

function materialItems(group) {
  const options = [];
  if (group.pdf_name) options.push(`<div class="material-link"><span>${escape(group.pdf_name)}</span><a class="text-link" href="/api/groups/${group.id}/pdf" target="_blank" rel="noopener">预览 PDF</a></div>`);
  if (group.deck_name) options.push(`<div class="material-link"><span>${escape(group.deck_name)}</span><a class="text-link" href="/api/groups/${group.id}/deck">下载 PPT</a></div>`);
  return options.join('') || '<p class="muted">暂无课件</p>';
}

function uploadForm(groups) {
  const first = groups[0];
  const options = groups.map(group => `<option value="${group.id}">${groupName(group.id)}</option>`).join('');
  return `<div class="panel-card"><h3>提交课件</h3><p class="muted">每组可提交一份 PPT/PPTX 和一份用于在线预览的 PDF。单个文件最多 30 MB。上传同类型文件会替换原文件。</p>
    <form class="form-grid" data-form="upload"><div class="inline-field">
    ${options && groups.length > 1 ? `<label>组别<select name="group">${options}</select></label>` : `<input type="hidden" name="group" value="${first.id}">`}
    <label>${groups.length === 1 ? groupName(first.id) + '课件' : '课件文件'}<input type="file" name="file" accept=".ppt,.pptx,.pdf" required></label>${button('上传课件', 'type="submit"')}</div></form></div>`;
}

function materialsPage() {
  const start = '<div class="subview">' + heading('课件交流', '查看和下载各组汇报材料。');
  if (!state.user) return start + loginForm() + '</div>';
  const editable = state.user.role === 'admin' ? state.groups : state.groups.filter(group => group.id === state.user.group_id);
  const upload = editable.length ? uploadForm(editable) : '<div class="panel-card"><p class="muted">管理员为你分组后，即可提交本组课件。</p></div>';
  return `${start}${upload}<div class="material-grid">${state.groups.map(group => {
    const owns = editable.includes(group);
    return `<article class="panel-card"><h3>${groupName(group.id)}${group.title ? ` · ${escape(group.title)}` : ''}</h3>${materialItems(group)}
      ${owns && (group.deck_name || group.pdf_name) ? `<div class="actions controls-block">
      ${group.deck_name ? button('移除 PPT', `data-action="delete-material" data-group="${group.id}" data-kind="deck"`, 'danger small') : ''}
      ${group.pdf_name ? button('移除 PDF', `data-action="delete-material" data-group="${group.id}" data-kind="pdf"`, 'danger small') : ''}</div>` : ''}</article>`;
  }).join('')}</div></div>`;
}

function groupControl(group) {
  const active = openGroup();
  const controls = group.state === 'open'
    ? [button('结束本轮', `data-action="close" data-group="${group.id}"`), group.votes ? '' : button('取消零票轮次', `data-action="cancel" data-group="${group.id}"`, 'secondary')]
    : group.state === 'pending' && !active ? [button('开放评分', `data-action="open" data-group="${group.id}"`, 'secondary')] : [];
  return `<article class="panel-card"><div class="group-head"><h3>${groupName(group.id)}</h3>${status(group)}</div>
    <p class="muted">${group.members} 位组员 · ${group.votes} / ${group.eligible} 份有效评分 · 均分 ${result(group.average)}</p>
    <form data-form="title" data-group="${group.id}" class="inline-field controls-block"><label>汇报主题<input name="title" maxlength="120" value="${escape(group.title)}" placeholder="输入主题"></label>${button('保存', 'type="submit"', 'secondary small')}</form>
    ${controls.length ? `<div class="actions controls-block">${controls.join('')}</div>` : ''}</article>`;
}

function adminPage() {
  const start = '<div class="subview">' + heading('课程管理', '', button('刷新数据', 'data-action="refresh"', 'secondary small'));
  if (state.user?.role !== 'admin') return start + loginForm(true) + '</div>';
  const active = openGroup();
  const rosterSize = state.groups.reduce((count, group) => count + group.members, state.unassigned);
  return `${start}
    <div class="panel-card"><h3>学生名单 <span class="muted">${rosterSize} 人${state.unassigned ? ` · ${state.unassigned} 人待分组` : ''}</span></h3>
    <p class="muted">导入后学生即可用学号登录。给名单加一列组号（1–8），即可一次导入多组。也可以上传单列学号名单，为整批选择同一组。</p>
    <form data-form="roster" class="form-grid">
      <label>上传名单<input type="file" name="file" accept=".csv,.tsv,.txt"><small class="muted">支持 UTF-8 编码的 CSV、TSV 和 TXT。Excel 名单可另存为 CSV UTF-8。</small></label>
      <label>或粘贴学号名单<textarea name="roster" placeholder="每行一个学号，也可从 Excel 复制学号和组号两列"></textarea></label>
      <label>未填写组号时<select name="defaultGroup"><option value="">暂不分组，或保留已有组别</option>${state.groups.map(group => `<option value="${group.id}">${groupName(group.id)}</option>`).join('')}</select></label>
      <div>${button('导入学生名单', 'type="submit"')}</div>
    </form></div>
    <div class="panel-card"><h3>成绩汇总</h3>
    <p class="muted">组均分为该组有效评分的算术平均值。全班总平均按八个组均分等权计算。</p>
    <p class="metric">全班总平均 <strong>${result(state.overall)}</strong></p>
    <p class="muted">${state.visible ? '组均分已向登录的课程成员发布。' : '成绩目前仅管理员可见。'}</p>
    <div class="actions controls-block"><a class="button secondary small" href="/api/admin/summary.csv">导出组均分</a><a class="button secondary small" href="/api/admin/scores.csv">导出实名明细</a>
    ${state.complete ? button(state.visible ? '撤回成绩发布' : '向课程成员发布成绩', 'data-action="publish"', 'small') : ''}</div></div>
    ${heading('管理评分轮次', active ? `${groupName(active.id)}正在收集评分。` : '同一时间可开放一个组，结束前请核对有效评分份数。')}
    <div class="admin-grid">${state.groups.map(groupControl).join('')}</div></div>`;
}

function render() {
  document.querySelectorAll('[data-tab]').forEach(link => {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (!state) return;
  const user = state.user;
  identity.innerHTML = user ? `<span>${user.role === 'admin' ? '管理员' : studentCaption(user)}</span>${button('退出', 'data-action="logout"', 'secondary small')}`
    : '<a class="button secondary small" href="#score">学生登录</a>';
  panel.innerHTML = ({ overview: overviewPage, score: scorePage, materials: materialsPage, admin: adminPage })[tab]();
  panel.removeAttribute('aria-busy');
}

function navigate() {
  const hash = location.hash.slice(1);
  if (hash === 'main') return;
  const next = pages.has(hash) ? hash : 'overview';
  if (next === tab) return;
  const moveFocus = !!tab;
  tab = next;
  message('');
  render();
  if (moveFocus) panel.querySelector('h2')?.focus();
}

function showLoadError(error) {
  if (state) return;
  panel.removeAttribute('aria-busy');
  panel.innerHTML = `<div class="panel-card"><p>${escape(error.message)}</p><div class="controls-block">${button('重新加载', 'data-action="refresh"')}</div></div>`;
}

async function run(action, element) {
  if (busy) return;
  busy = true;
  if (element) element.disabled = true;
  message('');
  try {
    const success = await action();
    if (success) message(success);
    try {
      await refresh(true);
    } catch (error) {
      message(success ? `${success} 页面状态刷新失败，请手动刷新。` : error.message, true);
    }
  } catch (error) {
    message(error.message, true);
    notice.scrollIntoView({ block: 'nearest' });
  } finally {
    busy = false;
    if (element) element.disabled = false;
  }
}

panel.addEventListener('submit', event => {
  const form = event.target;
  const { form: type, group } = form.dataset;
  if (!type) return;
  event.preventDefault();
  const values = new FormData(form);
  const handlers = {
    login: async () => {
      const input = form.dataset.admin === 'true' ? { admin: true, secret: values.get('secret') } : { studentId: values.get('studentId') };
      await write('/api/login', input);
      form.reset();
      return '身份验证成功。';
    },
    score: async () => {
      await write(`/api/groups/${group}/score`, { value: Number(values.get('score')) });
      return '已提交本轮评分。';
    },
    roster: async () => {
      const file = values.get('file');
      const pasted = values.get('roster').trim();
      if (file?.name && pasted) throw new Error('请选择上传文件或粘贴名单中的一种方式。');
      if (file?.size > 200 * 1024) throw new Error('名单文件不能超过 200 KB。');
      const roster = file?.name ? await file.text() : pasted;
      if (!roster.trim()) throw new Error('请上传文件或粘贴学号名单。');
      const defaultGroup = values.get('defaultGroup');
      const data = await write('/api/admin/roster', { roster, defaultGroup: defaultGroup ? Number(defaultGroup) : null });
      return `已导入 ${data.count} 位同学的学号。`;
    },
    title: async () => {
      await write(`/api/groups/${group}/config`, { action: 'title', title: values.get('title') });
      return '已保存汇报主题。';
    },
    upload: async () => {
      const file = values.get('file');
      if (!file?.size || file.size > 30 * 1024 * 1024) throw new Error('请选择不超过 30 MB 的课件文件。');
      const kind = /\.pdf$/i.test(file.name) ? 'pdf' : 'deck';
      message('正在上传课件…');
      await request(`/api/groups/${values.get('group')}/${kind}`, { method: 'PUT', headers: { 'X-Filename': encodeURIComponent(file.name) }, body: file });
      return '课件已上传。';
    },
  };
  run(handlers[type], event.submitter);
});

document.addEventListener('click', event => {
  const control = event.target.closest('button[data-action]');
  if (!control || busy) return;
  const { action, group, kind } = control.dataset;
  if (action === 'refresh') {
    control.disabled = true;
    refresh(true).then(() => message('已更新课程状态。')).catch(error => {
      showLoadError(error);
      message(error.message, true);
    }).finally(() => { control.disabled = false; });
    return;
  }
  if (action === 'close' && !confirm(`结束${groupName(group)}的评分？结束后本轮会锁定。`)) return;
  if (action === 'delete-material' && !confirm(`移除${groupName(group)}的这份课件？`)) return;
  const handlers = {
    logout: async () => {
      await write('/api/logout', {});
      return '已退出登录。';
    },
    publish: async () => {
      await write('/api/admin/results', { visible: !state.visible });
      return state.visible ? '已撤回成绩发布。' : '已向课程成员发布成绩。';
    },
    'delete-material': async () => {
      await request(`/api/groups/${group}/${kind}`, { method: 'DELETE' });
      return '课件已移除。';
    },
  };
  if (handlers[action]) return run(handlers[action], control);
  run(async () => {
    await write(`/api/groups/${group}/config`, { action });
    return ({ open: `${groupName(group)}已开放评分。`, close: `${groupName(group)}已结束评分。`, cancel: '已取消本轮开放。' })[action];
  }, control);
});

function drawWaves() {
  const canvas = document.querySelector('#waves');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const scale = Math.min(2, devicePixelRatio || 1);
  canvas.width = rect.width * scale;
  canvas.height = rect.height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(scale, scale);
  const w = rect.width;
  const h = rect.height;
  const warm = ctx.createRadialGradient(w * .79, h * .5, 8, w * .79, h * .5, h * .76);
  warm.addColorStop(0, '#3b89ef55');
  warm.addColorStop(1, '#10519b00');
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#91bdff20';
  ctx.lineWidth = .6;
  for (let x = w * .39; x < w; x += 24) {
    ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, h - 12); ctx.stroke();
  }
  for (let y = 16; y < h; y += 24) {
    ctx.beginPath(); ctx.moveTo(w * .39, y); ctx.lineTo(w, y); ctx.stroke();
  }
  for (let row = 0; row <= 34; row++) {
    const t = (row - 17) / 17;
    const color = ctx.createLinearGradient(w * .24, 0, w, 0);
    color.addColorStop(0, '#367cc100');
    color.addColorStop(.55, Math.abs(t) < .28 ? '#7ec9ffbe' : '#5796f285');
    color.addColorStop(.83, '#a9e1ffe5');
    color.addColorStop(1, '#4a9dff24');
    ctx.strokeStyle = color;
    ctx.lineWidth = row % 6 === 0 ? 1.24 : .67;
    ctx.beginPath();
    for (let i = 0; i <= 180; i++) {
      const x = i / 180;
      const envelope = Math.exp(-((x - .65) ** 2) / .068);
      const phase = 21 * x - t * 2.8;
      const vertical = .51 + t * (.23 * x + .085) + .29 * envelope * Math.sin(phase) * Math.cos(t * 1.13) + .044 * Math.sin(x * 13 + t * 3);
      const px = w * (.22 + .81 * x);
      const py = h * vertical;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

window.addEventListener('hashchange', navigate);
navigate();
refresh().catch(showLoadError);
setInterval(() => {
  if (!busy && !document.hidden && (tab === 'overview' || tab === 'score') && !panel.querySelector('form:focus-within')) {
    refresh().catch(() => {});
  }
}, 12000);
new ResizeObserver(drawWaves).observe(document.querySelector('.hero'));
