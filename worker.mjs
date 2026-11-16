const maxUpload = 30 * 1024 * 1024;
const cookieName = '__Host-aq-session';
const studentSessionAge = 12 * 3600;
const encoder = new TextEncoder();
const noCache = 'private, no-store';
const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; frame-src 'self'",
};

class CourseError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function response(body, headers, status = 200) {
  return new Response(body, { status, headers: { ...security, 'Cache-Control': noCache, ...headers } });
}

function json(body, status = 200, headers = {}) {
  return response(JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8', ...headers }, status);
}

async function bodyJson(request, limit = 64 * 1024) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new CourseError(415, '请使用站内表单提交。');
  try {
    return JSON.parse(new TextDecoder().decode(await readBytes(request, limit)));
  } catch (error) {
    if (error instanceof CourseError) throw error;
    throw new CourseError(400, '提交的数据格式不正确。');
  }
}

async function readBytes(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) throw new CourseError(413, '提交内容超过大小限制。');
  const reader = request.body?.getReader();
  if (!reader) throw new CourseError(400, '提交内容为空。');
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new CourseError(413, '提交内容超过大小限制。');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function digest(value) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function signStudentSession(payload, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`student-session:${payload}`)));
}

function normalizeId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[\p{L}\p{N}_-]{2,32}$/u.test(id) ? id.replace(/[a-z]/g, letter => letter.toUpperCase()) : null;
}

async function findStudent(db, id) {
  const { results } = await db.prepare(`
    SELECT id, group_id FROM students WHERE id = ?1 COLLATE NOCASE
    UNION ALL
    SELECT id, NULL AS group_id FROM unassigned_students WHERE id = ?1 COLLATE NOCASE
    LIMIT 2
  `).bind(id).all();
  return results.length === 1 ? results[0] : null;
}

function matches(left, right) {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return different === 0;
}

function sessionCookie(value, age) {
  return `${cookieName}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Strict`;
}

async function identity(request, env) {
  const secret = env.COURSE_ADMIN_PASSWORD;
  if (!secret) return null;
  const value = request.headers.get('Cookie')?.split(/;\s*/).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (/^a\.[a-f0-9]{64}$/.test(value ?? '')) {
    const expected = await digest(`admin-session:${secret}`);
    if (matches(value.slice(2), expected)) return { role: 'admin' };
  }
  const session = /^i\.([A-Z0-9_%a-z-]{2,400})\.(\d{10})\.([a-f0-9]{64})$/.exec(value ?? '');
  if (!session) return null;
  const [, encodedId, expires, signature] = session;
  if (Number(expires) <= Math.floor(Date.now() / 1000)) return null;
  const expected = await signStudentSession(`${encodedId}.${expires}`, secret);
  if (!matches(signature, expected)) return null;
  const student = await findStudent(env.DB, decodeURIComponent(encodedId));
  return student ? { role: 'student', ...student } : null;
}

function requireMember(user) {
  if (!user) throw new CourseError(401, '请先验证课堂身份。');
}

function requireAdmin(user) {
  if (user?.role !== 'admin') throw new CourseError(403, '此操作需要管理员身份。');
}

async function login(request, env) {
  const data = await bodyJson(request);
  const secret = typeof data?.secret === 'string' ? data.secret.trim() : '';
  if (data?.admin === true) {
    if (env.COURSE_ADMIN_PASSWORD && /^[A-Za-z0-9_-]{32}$/.test(secret)
      && matches(await digest(secret), await digest(env.COURSE_ADMIN_PASSWORD))) {
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(`a.${await digest(`admin-session:${env.COURSE_ADMIN_PASSWORD}`)}`, 6 * 3600) });
    }
  } else if (env.COURSE_ADMIN_PASSWORD) {
    const id = normalizeId(data?.studentId);
    if (id && await findStudent(env.DB, id)) {
      const payload = `${encodeURIComponent(id)}.${Math.floor(Date.now() / 1000) + studentSessionAge}`;
      const signature = await signStudentSession(payload, env.COURSE_ADMIN_PASSWORD);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(`i.${payload}.${signature}`, studentSessionAge) });
    }
  }
  throw new CourseError(401, data?.admin === true ? '管理员密码无效。' : '学号未在课程名单中，请核对后重试。');
}

async function groupRows(db) {
  return (await db.prepare(`
    SELECT g.id, g.title, g.state, g.deck_name, g.pdf_name,
      COUNT(s.student_id) AS votes, AVG(s.value) AS average,
      (SELECT COUNT(*) FROM students WHERE group_id <> g.id) AS eligible,
      (SELECT COUNT(*) FROM students WHERE group_id = g.id) AS members
    FROM groups g LEFT JOIN scores s ON s.group_id = g.id
    GROUP BY g.id ORDER BY g.id
  `).all()).results;
}

async function courseState(db, user) {
  if (!user) {
    const { results } = await db.prepare('SELECT id, state FROM groups ORDER BY id').all();
    return { groups: results, user: null };
  }
  const admin = user.role === 'admin';
  const [groups, course, pending] = await Promise.all([
    groupRows(db),
    db.prepare('SELECT results_visible FROM course WHERE id = 1').first(),
    admin ? db.prepare('SELECT COUNT(*) AS total FROM unassigned_students').first() : null,
  ]);
  const visible = Boolean(course.results_visible);
  const showScores = admin || visible;
  let mine = [];
  if (!admin && user.group_id != null) {
    const { results } = await db.prepare('SELECT group_id, value FROM scores WHERE student_id = ? ORDER BY group_id').bind(user.id).all();
    mine = results;
  }
  const complete = groups.length === 8 && groups.every(group => group.state === 'closed' && group.votes > 0);
  const overall = complete && showScores ? groups.reduce((total, group) => total + group.average, 0) / groups.length : null;
  return {
    user: admin ? { role: 'admin' } : { role: 'student', id: normalizeId(user.id), group_id: user.group_id },
    groups: groups.map(group => {
      const { id, title, state, deck_name, pdf_name, votes, average, eligible, members } = group;
      return { id, title, state, deck_name, pdf_name, ...(showScores ? { votes, average, eligible } : {}), ...(admin ? { members } : {}) };
    }),
    visible, complete, overall, mine, ...(admin ? { unassigned: pending.total } : {}),
  };
}

async function submitScore(request, db, user, group) {
  requireMember(user);
  if (user.role !== 'student') throw new CourseError(403, '请用学生学号登录后提交。');
  if (user.group_id == null) throw new CourseError(403, '管理员为你分组后，即可参与评分。');
  const { value } = (await bodyJson(request)) ?? {};
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new CourseError(400, '请输入 0 到 100 之间的整数。');
  if (user.group_id === group) throw new CourseError(403, '本组成员不能给本组评分。');
  let result;
  try {
    result = await db.prepare(`
      INSERT INTO scores (student_id, group_id, value) VALUES (?, ?, ?)
      ON CONFLICT(student_id, group_id) DO NOTHING
    `).bind(user.id, group, value).run();
  } catch (error) {
    const message = String(error);
    if (message.includes('same_group')) throw new CourseError(403, '本组成员不能给本组评分。');
    if (message.includes('round_not_open')) throw new CourseError(409, '该组当前未开放评分。');
    throw error;
  }
  if (!result.meta.changes) {
    const existing = await db.prepare('SELECT value FROM scores WHERE student_id = ? AND group_id = ?').bind(user.id, group).first();
    if (existing?.value === value) return json({ ok: true });
    throw new CourseError(409, '你已提交过这组的评分。');
  }
  return json({ ok: true }, 201);
}

function rosterCells(line) {
  const cells = line.includes('\t') ? line.split('\t') : line.split(/[,，](?=(?:[^"]*"[^"]*")*[^"]*$)/);
  return cells.map(cell => cell.trim().replace(/^"((?:[^"]|"")*)"$/, (_, value) => value.replaceAll('""', '"')));
}

async function rosterImport(request, db) {
  const { roster, defaultGroup = null } = (await bodyJson(request, 256 * 1024)) ?? {};
  if (typeof roster !== 'string') throw new CourseError(400, '请填写或上传学号名单。');
  if (defaultGroup != null && (!Number.isInteger(defaultGroup) || defaultGroup < 1 || defaultGroup > 8)) {
    throw new CourseError(400, '请选择正确的组别。');
  }
  const rows = roster.trim().split(/\r\n|\r|\n/).filter(line => line.trim()).map(rosterCells);
  if (/^(学号|student[_ ]?id|id)$/i.test(rows[0]?.[0] ?? '')) rows.shift();
  if (rows.length < 1 || rows.length > 500) throw new CourseError(400, '每次可导入 1 到 500 位同学。');

  const { results } = await db.prepare('SELECT id FROM students').all();
  const existing = new Map();
  for (const { id } of results) {
    const canonical = normalizeId(id);
    existing.set(canonical, existing.has(canonical) ? null : id);
  }
  const seen = new Set();
  const records = rows.map((cells, index) => {
    const [rawId, second = '', third = ''] = cells;
    const id = normalizeId(rawId);
    const name = cells.length === 3 ? second : '';
    const group = cells.length === 3 ? third : second;
    if (!id || (!existing.has(id) && !/^[A-Z]*[0-9]+$/.test(id)) || (group && !/^[1-8]$/.test(group)) || name.length > 60 || cells.length > 3) {
      throw new CourseError(400, `第 ${index + 1} 条记录格式有误，请检查学号和组号。`);
    }
    if (seen.has(id)) throw new CourseError(400, `第 ${index + 1} 条记录的学号重复。`);
    if (existing.get(id) === null) throw new CourseError(409, `第 ${index + 1} 条记录与多个现有学号冲突，请检查名册。`);
    seen.add(id);
    return { id: existing.get(id) ?? id, name, group: group ? Number(group) : defaultGroup };
  });

  const values = JSON.stringify(records);
  try {
    await db.batch([
      db.prepare(`
        WITH incoming AS (
          SELECT value->>'id' AS id, value->>'name' AS name, value->>'group' AS group_id FROM json_each(?)
        )
        INSERT INTO students (id, name, group_id, code_hash)
        SELECT incoming.id, COALESCE(NULLIF(incoming.name, ''), pending.name, ''), incoming.group_id, lower(hex(randomblob(32)))
        FROM incoming LEFT JOIN unassigned_students pending ON pending.id = incoming.id
        WHERE incoming.group_id IS NOT NULL
        ON CONFLICT(id) DO UPDATE SET
          name = COALESCE(NULLIF(excluded.name, ''), students.name), group_id = excluded.group_id
      `).bind(values),
      db.prepare(`
        WITH incoming AS (
          SELECT value->>'id' AS id, value->>'name' AS name, value->>'group' AS group_id FROM json_each(?)
        )
        INSERT INTO unassigned_students (id, name)
        SELECT id, name FROM incoming WHERE group_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM students WHERE students.id = incoming.id COLLATE NOCASE)
        ON CONFLICT(id) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, ''), unassigned_students.name)
      `).bind(values),
      db.prepare(`DELETE FROM unassigned_students WHERE id IN (
        SELECT value->>'id' FROM json_each(?) WHERE value->>'group' IS NOT NULL
      )`).bind(values),
    ]);
  } catch (error) {
    if (String(error).includes('group_locked')) throw new CourseError(409, '已有评分记录的同学不能变更所属组，本次导入已取消。');
    throw error;
  }
  return json({ count: records.length }, 201);
}

async function changeGroup(request, db, id) {
  const { action, title } = (await bodyJson(request)) ?? {};
  if (action === 'title') {
    if (typeof title !== 'string' || title.trim().length > 120) throw new CourseError(400, '汇报主题最多 120 个字符。');
    await db.prepare('UPDATE groups SET title = ? WHERE id = ?').bind(title.trim(), id).run();
    return json({ ok: true });
  }
  let query;
  let error;
  switch (action) {
    case 'open':
      query = `UPDATE groups SET state = 'open' WHERE id = ?1 AND state = 'pending'
        AND EXISTS (SELECT 1 FROM students WHERE group_id <> ?1)
        AND NOT EXISTS (SELECT 1 FROM groups WHERE state = 'open')`;
      error = '请先导入有资格的学生，并关闭正在进行的轮次。已结束的轮次不能重复开放。';
      break;
    case 'close':
      query = `UPDATE groups SET state = 'closed' WHERE id = ?1 AND state = 'open'
        AND EXISTS (SELECT 1 FROM scores WHERE group_id = ?1)`;
      error = '收到至少一份有效评分后才能结束。零票时可以取消开放。';
      break;
    case 'cancel':
      query = `UPDATE groups SET state = 'pending' WHERE id = ?1 AND state = 'open'
        AND NOT EXISTS (SELECT 1 FROM scores WHERE group_id = ?1)`;
      error = '仅零票的开放轮次可以取消。';
      break;
    default:
      throw new CourseError(400, '未知的轮次操作。');
  }
  const changed = await db.prepare(query).bind(id).run();
  if (!changed.meta.changes) throw new CourseError(409, error);
  return json({ ok: true });
}

async function publishResults(request, db) {
  const { visible } = (await bodyJson(request)) ?? {};
  if (typeof visible !== 'boolean') throw new CourseError(400, '请选择成绩可见状态。');
  const changed = await db.prepare(`UPDATE course SET results_visible = ?1 WHERE id = 1 AND (?1 = 0 OR
    (SELECT COUNT(*) FROM groups g WHERE g.state = 'closed' AND EXISTS (SELECT 1 FROM scores s WHERE s.group_id = g.id)) = 8)`)
    .bind(visible ? 1 : 0).run();
  if (!changed.meta.changes) throw new CourseError(409, '八组都已结束且有有效评分后，才能发布成绩。');
  return json({ ok: true });
}

function csvCell(value) {
  let escaped = String(value ?? '');
  if (/^(?:\s*[=+@-]|[\t\r\n])/.test(escaped)) escaped = `'${escaped}`;
  return `"${escaped.replaceAll('"', '""')}"`;
}

function csv(rows, filename) {
  const data = '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return response(data, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}.csv"` });
}

async function exportResults(db, type) {
  if (type === 'summary') {
    const groups = await groupRows(db);
    const rows = groups.map(g => [g.id, g.title, ({ pending: '待开放', open: '评分中', closed: '已结束' })[g.state], g.votes, g.eligible, g.average?.toFixed(2)]);
    if (groups.every(g => g.state === 'closed' && g.votes)) {
      rows.push(['全班总平均（八组等权）', '', '', '', '', (groups.reduce((total, g) => total + g.average, 0) / groups.length).toFixed(2)]);
    }
    return csv([['组别', '汇报主题', '轮次状态', '有效评分份数', '应评分人数', '平均分'], ...rows], 'group-summary');
  }
  const { results } = await db.prepare(`SELECT s.group_id, u.id, u.name, u.group_id AS voter_group, s.value, s.created_at
    FROM scores s JOIN students u ON u.id = s.student_id ORDER BY s.group_id, u.group_id, u.id`).all();
  return csv([['受评组', '学号', '姓名', '评分者所属组', '评分', '提交时间 UTC'], ...results.map(s => [s.group_id, s.id, s.name, s.voter_group, s.value, s.created_at])], 'named-scores');
}

const materialTypes = {
  pdf: { columns: ['pdf_key', 'pdf_name'], formats: /\.pdf$/i },
  deck: { columns: ['deck_key', 'deck_name'], formats: /\.pptx?$/i },
};

function validMaterial(bytes, name) {
  const signature = name.toLowerCase().endsWith('.pdf') ? [37, 80, 68, 70, 45]
    : name.toLowerCase().endsWith('.pptx') ? [80, 75, 3, 4] : [208, 207, 17, 224, 161, 177, 26, 225];
  return signature.every((value, index) => bytes[index] === value);
}

async function materials(request, env, user, id, kind, context) {
  requireMember(user);
  const { DB: db, BUCKET: bucket } = env;
  const { columns: [keyColumn, nameColumn], formats } = materialTypes[kind];
  const previous = await db.prepare(`SELECT ${keyColumn} AS storage_key, ${nameColumn} AS name FROM groups WHERE id = ?`).bind(id).first();
  if (request.method === 'GET') {
    if (!previous.storage_key) throw new CourseError(404, '该组暂未提交这类课件。');
    const file = await bucket.get(previous.storage_key);
    if (!file) throw new CourseError(404, '课件暂时无法读取，请联系该组重新上传。');
    const display = kind === 'pdf' && new URL(request.url).searchParams.get('download') !== '1' ? 'inline' : 'attachment';
    const fallback = kind === 'pdf' ? 'pdf' : previous.name.toLowerCase().endsWith('.pptx') ? 'pptx' : 'ppt';
    return response(file.body, { 'Content-Type': kind === 'pdf' ? 'application/pdf' : 'application/octet-stream',
      'Content-Disposition': `${display}; filename="group-${id}.${fallback}"; filename*=UTF-8''${encodeURIComponent(previous.name).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16))}`,
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'self'", 'Content-Length': String(file.size) });
  }
  if (user.role !== 'admin' && user.group_id !== id) throw new CourseError(403, '只能管理自己组的课件。');
  let name = null;
  let storageKey = null;
  if (request.method === 'PUT') {
    try {
      name = decodeURIComponent(request.headers.get('X-Filename') ?? '');
    } catch {
      throw new CourseError(400, '课件文件名无效。');
    }
    if (!name || name.length > 180 || /[\u0000-\u001f\u007f/\\]/.test(name) || !formats.test(name)) throw new CourseError(400, '课件文件名或类型不符合要求。');
    const bytes = await readBytes(request, maxUpload);
    if (!validMaterial(bytes, name)) throw new CourseError(400, '文件内容与所选格式不符。');
    storageKey = `groups/${id}/${kind}/${crypto.randomUUID()}`;
    await bucket.put(storageKey, bytes);
  }
  try {
    const update = await db.prepare(`UPDATE groups SET ${keyColumn} = ?, ${nameColumn} = ? WHERE id = ? AND ${keyColumn} IS ?`)
      .bind(storageKey, name, id, previous.storage_key).run();
    if (!update.meta.changes) throw new CourseError(409, '课件刚被其他成员更新，请刷新后重试。');
  } catch (error) {
    // Preserve the uploaded object if the database outcome is uncertain.
    if (storageKey && error instanceof CourseError) await bucket.delete(storageKey).catch(() => {});
    throw error;
  }
  if (previous.storage_key) context.waitUntil(bucket.delete(previous.storage_key).catch(() => {}));
  return json({ ok: true });
}

async function api(request, env, context, url) {
  const { pathname } = url;
  const method = request.method;
  if (method !== 'GET' && (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')) {
    throw new CourseError(403, '请从课程网站上提交。');
  }
  if (pathname === '/api/login' && method === 'POST') return login(request, env);
  if (pathname === '/api/logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  const user = await identity(request, env);
  if (pathname === '/api/state' && method === 'GET') return json(await courseState(env.DB, user));
  const route = pathname.match(/^\/api\/groups\/([1-8])\/(score|deck|pdf|config)$/);
  if (route) {
    const group = Number(route[1]);
    const action = route[2];
    if (action === 'score' && method === 'POST') return submitScore(request, env.DB, user, group);
    if (action in materialTypes && ['GET', 'PUT', 'DELETE'].includes(method)) return materials(request, env, user, group, action, context);
    if (action === 'config' && method === 'POST') {
      requireAdmin(user);
      return changeGroup(request, env.DB, group);
    }
  }
  if (pathname.startsWith('/api/admin/')) {
    requireAdmin(user);
    if (pathname === '/api/admin/roster' && method === 'POST') return rosterImport(request, env.DB);
    if (pathname === '/api/admin/results' && method === 'POST') return publishResults(request, env.DB);
    if (pathname === '/api/admin/summary.csv' && method === 'GET') return exportResults(env.DB, 'summary');
    if (pathname === '/api/admin/scores.csv' && method === 'GET') return exportResults(env.DB, 'scores');
  }
  throw new CourseError(404, '页面或操作不存在。');
}

export default {
  async fetch(request, env, context) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await api(request, env, context, url);
      const asset = Object.hasOwn(assets, url.pathname) && assets[url.pathname];
      if (!asset || !['GET', 'HEAD'].includes(request.method)) throw new CourseError(404, '页面不存在。');
      const bytes = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.base64), char => char.charCodeAt(0));
      return response(bytes, { 'Content-Type': asset.type });
    } catch (error) {
      if (error instanceof CourseError) return json({ error: error.message }, error.status);
      console.error('Course request failed', error?.message);
      return json({ error: '服务暂时不可用。请稍后重试。' }, 500);
    }
  },
};
