import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import worker from './dist/server/index.js';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(await readFile('drizzle/0000_course.sql', 'utf8'));
const oldCode = 'c12345678901234567890123456';
sqlite.prepare('INSERT INTO students (id, name, group_id, code_hash) VALUES (?, ?, 8, ?)')
  .run('sy2600099', '旧名单学生', createHash('sha256').update(oldCode).digest('hex'));
sqlite.exec(await readFile('drizzle/0001_unassigned_students.sql', 'utf8'));
const db = {
  prepare(sql) {
    const statement = sqlite.prepare(sql);
    const wrap = (parameters = []) => {
      const indexed = sql.includes('?1');
      const args = indexed ? [Object.fromEntries(parameters.map((value, index) => [`?${index + 1}`, value]))] : parameters;
      return {
        bind: (...values) => wrap(values),
        first: async () => statement.get(...args) ?? null,
        all: async () => ({ results: statement.all(...args) }),
        run: async () => ({ meta: statement.run(...args) }),
      };
    };
    return wrap();
  },
  async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
};
const objects = new Map();
const bucket = {
  async put(key, bytes) { objects.set(key, bytes); },
  async get(key) {
    const bytes = objects.get(key);
    return bytes ? { body: bytes, size: bytes.length } : null;
  },
  async delete(key) { objects.delete(key); },
};
const origin = 'https://course.example';
const pagesOrigin = 'https://zjzphysics.github.io';
const pagesHeaders = { Origin: pagesOrigin, 'Sec-Fetch-Site': 'cross-site' };
const env = { DB: db, BUCKET: bucket, COURSE_ADMIN_PASSWORD: randomBytes(24).toString('base64url') };

async function call(path, { method = 'GET', data, cookie, headers = {}, bytes } = {}) {
  const requestHeaders = { ...(method !== 'GET' ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers };
  if (data !== undefined) requestHeaders['Content-Type'] = 'application/json';
  return worker.fetch(new Request(origin + path, { method, headers: requestHeaders, body: data === undefined ? bytes : JSON.stringify(data) }), env, { waitUntil() {} });
}

async function post(path, data, cookie) {
  return call(path, { method: 'POST', data, cookie });
}

async function login(value, admin = false) {
  const response = await post('/api/login', admin ? { secret: value, admin } : { studentId: value });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Strict/);
  return response.headers.get('Set-Cookie').split(';')[0];
}

const assertStatus = async (promise, expected) => {
  const response = await promise;
  assert.equal(response.status, expected, await response.clone().text());
  return response;
};

const guest = await (await call('/api/state')).json();
assert.equal(guest.groups.length, 8);
assert.deepEqual(Object.keys(guest.groups[0]).sort(), ['id', 'state']);
await assertStatus(call('/'), 200);
await assertStatus(call('/api/admin/summary.csv'), 403);
await assertStatus(call('/api/admin/scores.csv'), 403);
await assertStatus(call('/api/groups/1/deck'), 401);
await assertStatus(post('/api/groups/1/score', { value: 100 }), 401);
await assertStatus(call('/api/login', { method: 'POST', data: { secret: env.COURSE_ADMIN_PASSWORD, admin: true }, headers: { Origin: 'https://other.example' } }), 403);

const preflight = await assertStatus(call('/api/groups/1/deck', { method: 'OPTIONS', headers: {
  ...pagesHeaders, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,x-filename',
} }), 204);
assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), pagesOrigin);
assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /\bPUT\b/);
assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
const foreignPreflight = await assertStatus(call('/api/state', { method: 'OPTIONS', headers: { Origin: 'https://other.example' } }), 403);
assert.equal(foreignPreflight.headers.get('Access-Control-Allow-Origin'), null);
const pagesDenied = await assertStatus(call('/api/login', { method: 'POST', data: { studentId: 'SY2600101' }, headers: pagesHeaders }), 401);
assert.equal(pagesDenied.headers.get('Access-Control-Allow-Origin'), pagesOrigin);

const pagesAdminLogin = await assertStatus(call('/api/login', { method: 'POST', data: { admin: true, secret: env.COURSE_ADMIN_PASSWORD }, headers: pagesHeaders }), 200);
assert.equal(pagesAdminLogin.headers.get('Set-Cookie'), null);
const { token: pagesAdmin } = await pagesAdminLogin.json();
const pagesAdminHeaders = { ...pagesHeaders, Authorization: `Bearer ${pagesAdmin}` };
await assertStatus(call('/api/admin/summary.csv', { headers: pagesAdminHeaders }), 200);
await assertStatus(call('/api/admin/summary.csv', { headers: { ...pagesAdminHeaders, Origin: 'https://other.example' } }), 403);
await assertStatus(call('/api/admin/summary.csv', { headers: { ...pagesHeaders, Authorization: `Bearer ${pagesAdmin.replace(/^p\.\d+/, 'p.1000000000')}` } }), 403);

const admin = await login(env.COURSE_ADMIN_PASSWORD, true);
await assertStatus(post('/api/groups/8/config', { action: 'open' }, admin), 409);
await assertStatus(post('/api/login', { studentId: 'SY2600001' }), 401);
await assertStatus(post('/api/login', { secret: oldCode }), 401);
assert.equal((await (await call('/api/state', { cookie: `__Host-aq-session=s.${oldCode}` })).json()).user, null);
const oldStudent = await login('SY2600099');
assert.deepEqual((await (await call('/api/state', { cookie: oldStudent })).json()).user, { role: 'student', id: 'SY2600099', group_id: 8 });
await assertStatus(post('/api/admin/roster', { roster: 'SY2600001\nsy2600001' }, admin), 400);
await assertStatus(post('/api/admin/roster', { roster: 'SY2600007,9' }, admin), 400);
await assertStatus(post('/api/admin/roster', { roster: 'SY2600007' }), 403);
const uploaded = await (await assertStatus(post('/api/admin/roster', { roster: '\ufeff"学号"\r\n"sy2600001"\r\nSY2600004' }, admin), 201)).json();
assert.deepEqual(uploaded, { count: 2 });
const [student1, pending] = await Promise.all(['  sY2600001 ', 'sy2600004'].map(id => login(id)));
assert.deepEqual((await (await call('/api/state', { cookie: student1 })).json()).user, { role: 'student', id: 'SY2600001', group_id: null });
assert.equal((await (await call('/api/state', { cookie: admin })).json()).unassigned, 2);
await assertStatus(post('/api/groups/2/score', { value: 100 }, student1), 403);
const forged = student1.replace('SY2600001', 'SY2600004');
assert.equal((await (await call('/api/state', { cookie: forged })).json()).user, null);
await assertStatus(post('/api/admin/roster', { roster: 'SY2600001', defaultGroup: 1 }, admin), 201);
assert.equal((await (await call('/api/state', { cookie: student1 })).json()).user.group_id, 1);
await assertStatus(post('/api/admin/roster', { roster: '学号\t姓名\t组号\nSY2600002\t测试乙\t2\nSY2600003\t测试丙\t3' }, admin), 201);
const [student2, student3] = await Promise.all(['SY2600002', 'sy2600003'].map(id => login(id)));
const pagesStudentLogin = await assertStatus(call('/api/login', { method: 'POST', data: { studentId: 'sy2600002' }, headers: pagesHeaders }), 200);
assert.equal(pagesStudentLogin.headers.get('Set-Cookie'), null);
const { token: pagesStudent } = await pagesStudentLogin.json();
const pagesStudentHeaders = { ...pagesHeaders, Authorization: `Bearer ${pagesStudent}` };
const pagesStudentState = await (await call('/api/state', { headers: pagesStudentHeaders })).json();
assert.deepEqual(pagesStudentState.user, { role: 'student', id: 'SY2600002', group_id: 2 });
await assertStatus(call('/api/admin/scores.csv', { headers: pagesStudentHeaders }), 403);
await assertStatus(post('/api/admin/roster', { roster: 'student_id,group\nsy2600099,8' }, admin), 201);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM students WHERE id = 'SY2600099' COLLATE NOCASE").get().total, 1);
await assertStatus(post('/api/groups/1/config', { action: 'title', title: '自旋研究' }, admin), 200);
await assertStatus(post('/api/groups/1/config', { action: 'open' }, admin), 200);
await assertStatus(post('/api/groups/2/config', { action: 'open' }, admin), 409);
await assertStatus(post('/api/groups/1/config', { action: 'close' }, admin), 409);
await assertStatus(post('/api/groups/1/score', { value: 100 }, student1), 403);
await assertStatus(post('/api/groups/1/score', { value: 100 }, pending), 403);
await assertStatus(post('/api/groups/2/score', { value: 100 }, student1), 409);
await assertStatus(post('/api/groups/1/score', { value: 101 }, student2), 400);
await assertStatus(post('/api/groups/1/score', { value: 80 }, student2), 201);
await assertStatus(call('/api/groups/1/score', { method: 'POST', data: { value: 80 }, headers: pagesStudentHeaders }), 200);
await assertStatus(post('/api/groups/1/score', { value: 80 }, student2), 200);
await assertStatus(post('/api/groups/1/score', { value: 81 }, student2), 409);
await assertStatus(post('/api/groups/1/score', { value: 100 }, student3), 201);
await assertStatus(post('/api/admin/roster', { roster: 'SY2600010,3\nsy2600002,测试乙,1' }, admin), 409);
await assertStatus(post('/api/login', { studentId: 'SY2600010' }), 401);
await assertStatus(post('/api/groups/1/config', { action: 'close' }, admin), 200);
await assertStatus(post('/api/groups/1/config', { action: 'open' }, admin), 409);
await assertStatus(post('/api/admin/results', { visible: true }, admin), 409);

const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF');
const options = { method: 'PUT', headers: { 'X-Filename': encodeURIComponent('实验附件.pdf') }, bytes: pdf };
await assertStatus(call('/api/groups/1/pdf', { ...options, cookie: student2 }), 403);
await assertStatus(call('/api/groups/1/pdf', { ...options, cookie: pending }), 403);
await assertStatus(call('/api/groups/1/pdf', { ...options, cookie: student1 }), 200);
await assertStatus(call('/api/groups/1/pdf'), 401);
const readPdf = await assertStatus(call('/api/groups/1/pdf', { cookie: student2 }), 200);
assert.match(readPdf.headers.get('Content-Disposition'), /^inline/);
assert.deepEqual(new Uint8Array(await readPdf.arrayBuffer()), pdf);
const pagesPdf = await assertStatus(call('/api/groups/1/pdf', { headers: pagesStudentHeaders }), 200);
assert.equal(pagesPdf.headers.get('Access-Control-Allow-Origin'), pagesOrigin);
assert.deepEqual(new Uint8Array(await pagesPdf.arrayBuffer()), pdf);
await assertStatus(call('/api/groups/1/deck', { ...options, cookie: student1, headers: { 'X-Filename': 'wrong.pptx' } }), 400);
const deck = new Uint8Array([80, 75, 3, 4, 0, 1]);
await assertStatus(call('/api/groups/1/deck', { ...options, bytes: deck, cookie: student1, headers: { 'X-Filename': 'example.pptx' } }), 200);
const readDeck = await assertStatus(call('/api/groups/1/deck', { cookie: student2 }), 200);
assert.match(readDeck.headers.get('Content-Disposition'), /^attachment/);
assert.deepEqual(new Uint8Array(await readDeck.arrayBuffer()), deck);
await assertStatus(call('/api/groups/1/deck', { method: 'DELETE', cookie: student1 }), 200);
await assertStatus(call('/api/groups/1/deck', { cookie: student2 }), 404);

for (let group = 2; group <= 8; group++) {
  await assertStatus(post(`/api/groups/${group}/config`, { action: 'open' }, admin), 200);
  await assertStatus(post(`/api/groups/${group}/score`, { value: group === 8 ? 0 : 80 }, student1), 201);
  await assertStatus(post(`/api/groups/${group}/config`, { action: 'close' }, admin), 200);
}
const beforePublication = await (await call('/api/state', { cookie: student1 })).json();
assert.equal(beforePublication.overall, null);
assert.equal(beforePublication.groups[0].average, undefined);
await assertStatus(post('/api/admin/results', { visible: true }, admin), 200);
const published = await (await call('/api/state', { cookie: student1 })).json();
assert.equal(published.overall, 71.25);
assert.equal(published.groups[0].average, 90);
assert.equal(published.groups[7].average, 0);
assert.equal(published.mine.length, 7);
assert.doesNotMatch(JSON.stringify(published), /测试乙|SY2600002/);
assert.doesNotMatch(await (await call('/api/state')).text(), /实验附件|自旋研究|average|votes|测试|SY2600001/);
await assertStatus(call('/api/admin/scores.csv', { cookie: student2 }), 403);
assert.match(await (await call('/api/admin/scores.csv', { cookie: admin })).text(), /测试乙/);
assert.match(await (await call('/api/admin/summary.csv', { cookie: admin })).text(), /71\.25/);
await assertStatus(post('/api/admin/roster', { roster: 'sy2600001' }, admin), 201);
assert.equal((await (await call('/api/state', { cookie: student1 })).json()).user.group_id, 1);
const largeRoster = Array.from({ length: 500 }, (_, index) => `ZZ270${String(index).padStart(4, '0')}`).join('\n');
assert.equal((await (await assertStatus(post('/api/admin/roster', { roster: largeRoster }, admin), 201)).json()).count, 500);
assert.equal((await (await call('/api/state', { cookie: admin })).json()).unassigned, 501);
await login('zz2700499');
sqlite.close();
console.log('Course checks passed: ID sign-in, bulk roster, group assignment, all 8 rounds, score exports, and PPT/PDF storage.');
