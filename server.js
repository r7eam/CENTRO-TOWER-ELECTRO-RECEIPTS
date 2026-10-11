// CENTRO TOWER — electricity receipts. Start:  node server.js   (or double-click "Start Centro Tower.bat")
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const D = require('./server/db');
const L = require('./server/logic');
const { importFile } = require('./server/importer');
const { toCsv, toXlsx } = require('./server/export');
const MIR = require('./server/mirror');

const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.slice(7) : process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const db = D.open();
const AppError = L.AppError;

// ------------------------------------------------------------------ backups
fs.mkdirSync(D.BACKUP_DIR, { recursive: true });
function backup(kind = 'manual') {
  const d = L.now();
  const p2 = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const name = kind === 'auto' ? `auto_${day}.db` : `centro_${day}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.db`;
  const file = path.join(D.BACKUP_DIR, name);
  if (fs.existsSync(file)) { if (kind === 'auto') return name; fs.unlinkSync(file); }
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  MIR.mirrorFile(db, name);                       // second copy outside this disk (if set up)
  return name;
}
function listBackups() {
  return fs.readdirSync(D.BACKUP_DIR).filter((f) => f.endsWith('.db'))
    .map((f) => ({ file: f, size: fs.statSync(path.join(D.BACKUP_DIR, f)).size, at: fs.statSync(path.join(D.BACKUP_DIR, f)).mtime }))
    .sort((a, b) => b.at - a.at);
}
function autoBackup() {
  try {
    if (!L.getSettings(db).SetupDone) return;
    backup('auto');
    const autos = listBackups().filter((b) => b.file.startsWith('auto_'));
    for (const b of autos.slice(60)) fs.unlinkSync(path.join(D.BACKUP_DIR, b.file));   // keep 60 daily copies
    MIR.catchUp(db);                              // e.g. the USB stick was plugged in again
  } catch (e) { console.error('auto backup failed:', e.message); }
}

// ------------------------------------------------------------------ sessions
const adminTokens = new Map();               // token → expiry ms (30 min, sliding)
const ADMIN_TTL = 30 * 60 * 1000;
function userFor(req) {
  const t = req.headers['x-token'];
  if (!t) return null;
  return db.prepare(`SELECT u.UserID id, u.Name name FROM Sessions s JOIN Users u ON u.UserID = s.UserID
                     WHERE s.Token = ? AND u.Active = 1`).get(String(t)) || null;
}
function newSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO Sessions (Token, UserID, CreatedAt) VALUES (?, ?, ?)').run(token, userId, L.stamp());
  return token;
}
function isAdmin(req) {
  const t = req.headers['x-admin'];
  const exp = t && adminTokens.get(String(t));
  if (!exp || exp < Date.now()) { if (t) adminTokens.delete(String(t)); return false; }
  adminTokens.set(String(t), Date.now() + ADMIN_TTL);
  return true;
}

// ------------------------------------------------------------------ http helpers
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 2e6) { reject(new AppError('tooLarge', {}, 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new AppError('badJson')); }
    });
    req.on('error', reject);
  });
}
function readToFile(req, file, max = 500e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const ws = fs.createWriteStream(file);
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); ws.destroy(); reject(new AppError('tooLarge', {}, 413)); } });
    req.pipe(ws);
    ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}
// addresses phones can use: real Wi-Fi/Ethernet first; virtual adapters (VirtualBox, VPNs…) and
// link-local 169.254.x.x are left out unless nothing else exists
function lanUrls() {
  const VIRTUAL = /virtual|vmware|vbox|vethernet|hyper-v|wsl|docker|radmin|hamachi|zerotier|tailscale|loopback|bluetooth|vpn|tap|tun/i;
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) all.push({ name, ip: a.address });
  const real = all.filter((x) => !x.ip.startsWith('169.254.') && !VIRTUAL.test(x.name));
  const rank = (x) => (/wi-?fi|wlan|wireless/i.test(x.name) ? 0 : /ethernet|^eth|^en/i.test(x.name) ? 1 : 2);
  return (real.length ? real : all).sort((a, b) => rank(a) - rank(b)).map((x) => `http://${x.ip}:${PORT}  (${x.name})`);
}

// ------------------------------------------------------------------ routes
const routes = [];
const route = (method, pattern, opts, fn, more = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn, ...opts, ...more });
};
const PUBLIC_ROUTE = { auth: false }, USER = { auth: true }, ADMIN = { auth: true, admin: true };

route('GET', '/api/bootstrap', PUBLIC_ROUTE, (ctx) => {
  const s = L.getSettings(db);
  return {
    setupDone: !!s.SetupDone, lang: s.Lang, prefix: s.Prefix, texts: L.texts(db), today: L.today(),
    user: ctx.user, users: db.prepare('SELECT Name name, PinHash IS NOT NULL hasPin FROM Users WHERE Active = 1 ORDER BY Name').all()
      .map((u) => ({ name: u.name, hasPin: !!u.hasPin })),
    preview: L.peekNextNo(db),
    backupWarning: ctx.user && s.SetupDone ? MIR.warning(db) : null,
  };
});

route('POST', '/api/setup', PUBLIC_ROUTE, (ctx) => {
  const s = L.getSettings(db);
  if (s.SetupDone) throw new AppError('alreadySetup', {}, 403);
  const b = ctx.body;
  const pw = String(b.adminPassword || '');
  if (pw.length < 4) throw new AppError('pwShort');
  const name = L.clean(b.userName, 60);
  if (!name) throw new AppError('needName');
  const prefix = L.clean(L.normDigits(b.prefix || '01-'), 10) || '01-';
  const start = L.toInt(b.startNo);
  const next = Number.isInteger(start) && start > 0 ? start : 1;
  const { salt, hash } = L.hashSecret(pw);
  const lang = b.lang === 'ar' ? 'ar' : 'ku';
  let uid;
  D.tx(db, () => {
    db.prepare('UPDATE Settings SET Prefix = ?, NextNo = ?, AdminHash = ?, AdminSalt = ?, SetupDone = 1, Lang = ? WHERE ID = 1')
      .run(prefix, Math.max(next, L.maxNumber(db, prefix) + 1), hash, salt, lang);
    uid = Number(db.prepare('INSERT INTO Users (Name) VALUES (?)').run(name).lastInsertRowid);
    L.audit(db, name, 'settings', {}, 'setup', null, `prefix ${prefix}, first no ${next}`);
  });
  return { token: newSession(uid), user: { id: uid, name } };
});

route('POST', '/api/login', PUBLIC_ROUTE, (ctx) => {
  const u = db.prepare('SELECT * FROM Users WHERE Name = ? AND Active = 1').get(String(ctx.body.name || ''));
  if (!u) throw new AppError('badLogin', {}, 401);
  if (u.PinHash && !L.checkSecret(String(ctx.body.pin || ''), u.PinSalt, u.PinHash)) throw new AppError('badLogin', {}, 401);
  return { token: newSession(u.UserID), user: { id: u.UserID, name: u.Name } };
});
route('POST', '/api/logout', PUBLIC_ROUTE, (ctx) => {
  db.prepare('DELETE FROM Sessions WHERE Token = ?').run(String(ctx.req.headers['x-token'] || ''));
  return { ok: true };
});
route('POST', '/api/lang', PUBLIC_ROUTE, (ctx) => {
  const lang = ctx.body.lang === 'ar' ? 'ar' : 'ku';
  db.prepare('UPDATE Settings SET Lang = ? WHERE ID = 1').run(lang);
  return { lang };
});

// receipts
route('GET', '/api/receipts', USER, () => L.listReceipts(db));
route('GET', '/api/receipts/:id', USER, (ctx) => {
  const r = L.toJson(L.getRow(db, Number(ctx.params.id)));
  if (!r) throw new AppError('notFound', {}, 404);
  return r;
});
route('POST', '/api/receipts', USER, (ctx) => L.createReceipt(db, ctx.body.receipt || {}, ctx.user.name, !!ctx.body.confirmDup));
route('PUT', '/api/receipts/:id', USER, (ctx) => L.updateReceipt(db, Number(ctx.params.id), ctx.body.receipt || {}, ctx.user.name, !!ctx.body.confirmDup));
route('POST', '/api/receipts/:id/void', USER, (ctx) => L.voidReceipt(db, Number(ctx.params.id), ctx.user.name));

// apartments + reports
route('GET', '/api/apartments', USER, () => L.apartments(db));
route('GET', '/api/reports/apartment', USER, (ctx) => L.aptReport(db, ctx.query.get('apt'), ctx.query.get('year')));
route('GET', '/api/reports/monthly', USER, (ctx) => L.monthly(db, ctx.query.get('year')));
route('GET', '/api/reports/month', USER, (ctx) => L.monthApts(db, ctx.query.get('year'), ctx.query.get('month')));

// admin
route('POST', '/api/admin/unlock', USER, (ctx) => {
  const s = L.getSettings(db);
  if (!L.checkSecret(String(ctx.body.password || ''), s.AdminSalt, s.AdminHash)) throw new AppError('badPw', {}, 401);
  const t = crypto.randomBytes(24).toString('hex');
  adminTokens.set(t, Date.now() + ADMIN_TTL);
  return { adminToken: t };
});
route('GET', '/api/admin/settings', ADMIN, () => {
  const s = L.getSettings(db);
  return { prefix: s.Prefix, nextNo: s.NextNo, preview: L.peekNextNo(db), lanUrls: lanUrls(), backups: listBackups(), dataDir: D.DATA_DIR };
});
route('PUT', '/api/admin/book', ADMIN, (ctx) => L.setBook(db, ctx.body.prefix, ctx.body.nextNo, ctx.user.name));
route('PUT', '/api/admin/password', ADMIN, (ctx) => {
  const pw = String(ctx.body.password || '');
  if (pw.length < 4) throw new AppError('pwShort');
  const { salt, hash } = L.hashSecret(pw);
  db.prepare('UPDATE Settings SET AdminHash = ?, AdminSalt = ? WHERE ID = 1').run(hash, salt);
  L.audit(db, ctx.user.name, 'settings', {}, 'AdminPassword', null, 'changed');
  return { ok: true };
});

route('GET', '/api/admin/apartments', ADMIN, () => L.apartments(db));
function saveApt(ctx, isNew) {
  const b = ctx.body;
  const apt = isNew ? L.normApt(b.apt) : decodeURIComponent(ctx.params.apt);
  if (!apt) throw new AppError('needData');
  const exists = db.prepare('SELECT * FROM Apartments WHERE ApartmentNo = ?').get(apt);
  if (isNew && exists) throw new AppError('aptExists');
  if (!isNew && !exists) throw new AppError('notFound', {}, 404);
  const v = [L.clean(b.floor, 20), L.clean(b.owner, 120), L.clean(b.tenant, 120), L.clean(L.normDigits(b.phone), 40), b.active === false ? 0 : 1];
  D.tx(db, () => {
    if (isNew) db.prepare('INSERT INTO Apartments (Floor, OwnerName, TenantName, Phone, Active, ApartmentNo) VALUES (?, ?, ?, ?, ?, ?)').run(...v, apt);
    else db.prepare('UPDATE Apartments SET Floor = ?, OwnerName = ?, TenantName = ?, Phone = ?, Active = ? WHERE ApartmentNo = ?').run(...v, apt);
    L.audit(db, ctx.user.name, 'settings', {}, `Apartment ${apt}`, exists ? JSON.stringify([exists.Floor, exists.OwnerName, exists.TenantName, exists.Phone, exists.Active]) : null, JSON.stringify(v));
  });
  return L.apartments(db);
}
route('POST', '/api/admin/apartments', ADMIN, (ctx) => saveApt(ctx, true));
route('PUT', '/api/admin/apartments/:apt', ADMIN, (ctx) => saveApt(ctx, false));

route('GET', '/api/admin/users', ADMIN, () =>
  db.prepare('SELECT UserID id, Name name, PinHash IS NOT NULL hasPin, Active active FROM Users ORDER BY Name').all()
    .map((u) => ({ ...u, hasPin: !!u.hasPin, active: !!u.active })));
route('POST', '/api/admin/users', ADMIN, (ctx) => {
  const name = L.clean(ctx.body.name, 60);
  if (!name) throw new AppError('needName');
  if (db.prepare('SELECT 1 FROM Users WHERE Name = ?').get(name)) throw new AppError('userExists');
  const pin = String(ctx.body.pin || '').trim();
  const h = pin ? L.hashSecret(pin) : { salt: null, hash: null };
  db.prepare('INSERT INTO Users (Name, PinHash, PinSalt) VALUES (?, ?, ?)').run(name, h.hash, h.salt);
  L.audit(db, ctx.user.name, 'settings', {}, 'User added', null, name);
  return { ok: true };
});
route('PUT', '/api/admin/users/:id', ADMIN, (ctx) => {
  const id = Number(ctx.params.id);
  const u = db.prepare('SELECT * FROM Users WHERE UserID = ?').get(id);
  if (!u) throw new AppError('notFound', {}, 404);
  const pin = ctx.body.pin === undefined ? undefined : String(ctx.body.pin).trim();
  if (pin) { const h = L.hashSecret(pin); db.prepare('UPDATE Users SET PinHash = ?, PinSalt = ? WHERE UserID = ?').run(h.hash, h.salt, id); }
  if (ctx.body.clearPin) db.prepare('UPDATE Users SET PinHash = NULL, PinSalt = NULL WHERE UserID = ?').run(id);
  if (ctx.body.active === false && u.Active &&
      db.prepare('SELECT COUNT(*) n FROM Users WHERE Active = 1').get().n <= 1) throw new AppError('lastUser');
  if (typeof ctx.body.active === 'boolean') {
    db.prepare('UPDATE Users SET Active = ? WHERE UserID = ?').run(ctx.body.active ? 1 : 0, id);
    if (!ctx.body.active) db.prepare('DELETE FROM Sessions WHERE UserID = ?').run(id);
  }
  L.audit(db, ctx.user.name, 'settings', {}, `User ${u.Name}`, null, JSON.stringify({ pin: pin ? 'changed' : ctx.body.clearPin ? 'removed' : undefined, active: ctx.body.active }));
  return { ok: true };
});

route('PUT', '/api/admin/texts/:key', ADMIN, (ctx) => {
  const key = decodeURIComponent(ctx.params.key);
  const old = db.prepare('SELECT * FROM Texts WHERE Key = ?').get(key);
  if (!old) throw new AppError('notFound', {}, 404);
  const ku = String(ctx.body.ku ?? old.KU), ar = String(ctx.body.ar ?? old.AR);
  db.prepare('UPDATE Texts SET KU = ?, AR = ? WHERE Key = ?').run(ku, ar, key);
  L.audit(db, ctx.user.name, 'settings', {}, `Text ${key}`, `${old.KU} | ${old.AR}`, `${ku} | ${ar}`);
  return L.texts(db);
});
route('POST', '/api/admin/texts/:key/reset', ADMIN, (ctx) => {
  const key = decodeURIComponent(ctx.params.key);
  const def = D.DEFAULT_TEXTS[key];
  if (!def) throw new AppError('notFound', {}, 404);
  const old = db.prepare('SELECT * FROM Texts WHERE Key = ?').get(key);
  db.prepare('UPDATE Texts SET KU = ?, AR = ? WHERE Key = ?').run(def[0], def[1], key);
  L.audit(db, ctx.user.name, 'settings', {}, `Text ${key}`, old ? `${old.KU} | ${old.AR}` : null, `${def[0]} | ${def[1]} (default)`);
  return L.texts(db);
});
route('GET', '/api/admin/audit', ADMIN, (ctx) => {
  const q = `%${ctx.query.get('q') || ''}%`;
  return db.prepare(`SELECT * FROM AuditLog WHERE COALESCE(ReceiptNo,'') LIKE ? OR COALESCE(UserName,'') LIKE ? OR COALESCE(Field,'') LIKE ?
                     ORDER BY ID DESC LIMIT 500`).all(q, q, q);
});
route('POST', '/api/admin/import', ADMIN, async (ctx) => {
  const name = path.basename(ctx.query.get('name') || 'import.csv');
  const tmp = path.join(os.tmpdir(), `centro-upload-${Date.now()}${path.extname(name)}`);
  await readToFile(ctx.req, tmp);
  try {
    backup('manual');                                  // safety copy before every import
    return await importFile(db, tmp, name, ctx.user.name);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('errServer', { msg: e.message }, 500);
  } finally { fs.unlink(tmp, () => {}); }
}, { rawBody: true });
route('POST', '/api/admin/backup', ADMIN, () => ({ file: backup('manual'), backups: listBackups(), mirror: MIR.getStatus(db) }));

// second backup folders
route('GET', '/api/admin/mirror', ADMIN, async () => ({
  dirs: MIR.getDirs(db), status: MIR.getStatus(db), suggestions: await MIR.suggestions(), warning: MIR.warning(db) }));
route('PUT', '/api/admin/mirror', ADMIN, (ctx) => {
  const list = (Array.isArray(ctx.body.dirs) ? ctx.body.dirs : []).map((d) => String(d).trim()).filter(Boolean);
  const dirs = [...new Set(list.map(MIR.checkDir))];
  // a folder on a USB stick that is not plugged in right now is accepted; anything else must be writable now
  for (const dir of dirs) {
    if (!fs.existsSync(path.parse(dir).root)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.centro-write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    } catch { throw new AppError('dirNotWritable', { dir }); }
  }
  const old = MIR.getDirs(db);
  db.prepare('UPDATE Settings SET MirrorDirs = ? WHERE ID = 1').run(JSON.stringify(dirs));
  L.audit(db, ctx.user.name, 'settings', {}, 'MirrorDirs', old.join(' ; ') || null, dirs.join(' ; ') || null);
  if (dirs.length) backup('manual');             // first copy right away
  return { dirs, status: MIR.getStatus(db), warning: MIR.warning(db) };
});
route('GET', '/api/admin/backups/:file', ADMIN, (ctx) => {
  const f = path.basename(decodeURIComponent(ctx.params.file));
  const p = path.join(D.BACKUP_DIR, f);
  if (!f.endsWith('.db') || !fs.existsSync(p)) throw new AppError('notFound', {}, 404);
  return { raw: fs.readFileSync(p), type: 'application/octet-stream', file: f };
});
route('GET', '/api/admin/export.csv', ADMIN, () => ({ raw: toCsv(db), type: 'text/csv; charset=utf-8', file: `receipts_${L.today()}.csv` }));
route('GET', '/api/admin/export.xlsx', ADMIN, () => ({
  raw: toXlsx(db), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', file: `receipts_${L.today()}.xlsx` }));

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');
    return serveStatic(req, res, url.pathname);
  }
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) return send(res, 404, { error: 'notFound' });
  try {
    const m = r.re.exec(url.pathname);
    const ctx = { req, query: url.searchParams, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) };
    ctx.user = userFor(req);
    if (r.auth && !ctx.user) throw new AppError('needLogin', {}, 401);
    if (r.admin && !isAdmin(req)) throw new AppError('needAdmin', {}, 403);
    ctx.body = r.rawBody ? {} : await readJson(req);
    const out = await r.fn(ctx);
    if (out && out.raw !== undefined) {
      return send(res, 200, out.raw, out.type, { 'Content-Disposition': `attachment; filename="${out.file}"` });
    }
    send(res, 200, out ?? {});
  } catch (e) {
    if (e instanceof AppError) return send(res, e.status, { error: e.key, params: e.params, dups: e.dups });
    console.error(e);
    send(res, 500, { error: 'errServer', params: { msg: e.message } });
  }
});

function openBrowser() { exec(`start "" "http://localhost:${PORT}"`); }
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Centro Tower is already running on port ${PORT}.`);
    if (process.argv.includes('--open')) openBrowser();
    setTimeout(() => process.exit(0), 500);
  } else { console.error(e); process.exit(1); }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  CENTRO TOWER — electricity receipts');
  console.log(`  On this PC:   http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  Phones (same Wi-Fi):  ${u}`);
  console.log(`  Data file:    ${D.DB_FILE}`);
  console.log('  Keep this window open while the system is in use. Close it to stop.');
  console.log('');
  autoBackup();
  setInterval(autoBackup, 10 * 60 * 1000);       // every 10 min: today's copy + catch up unplugged folders
  if (process.argv.includes('--open')) openBrowser();
});

module.exports = { server, db };
