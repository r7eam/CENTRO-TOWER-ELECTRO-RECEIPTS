// Business rules: validation, receipt numbering, saving, voiding, reports.
const crypto = require('crypto');
const { tx } = require('./db');

// ------------------------------------------------------------------ helpers
const pad2 = (n) => String(n).padStart(2, '0');

// "today" — CENTRO_TODAY=yyyy-mm-dd overrides it (used by the tests)
function now() {
  if (process.env.CENTRO_TODAY) {
    const [y, m, d] = process.env.CENTRO_TODAY.split('-').map(Number);
    const r = new Date(); r.setFullYear(y, m - 1, d); return r;
  }
  return new Date();
}
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const stamp = (d = now()) => `${isoDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const today = () => isoDate(now());

// Arabic-Indic / Persian digits → 0-9 (phones often type ٢٣)
function normDigits(s) {
  return String(s ?? '').replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x06F0);
}
const clean = (s, max) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, max) : null;
};
function normApt(s) {
  const v = clean(normDigits(s), 20);
  return v ? v.toUpperCase() : null;
}
// apartment sort: numerically, then as text (2 < 10 < 10B < A1)
function aptCmp(a, b) {
  const na = /^\d+/.exec(a), nb = /^\d+/.exec(b);
  if (na && nb && +na[0] !== +nb[0]) return +na[0] - +nb[0];
  if (na && !nb) return -1;
  if (!na && nb) return 1;
  return a.localeCompare(b, 'en');
}
// accepts yyyy-mm-dd or dd/mm/yyyy (optionally with a time) → yyyy-mm-dd or null
function parseDate(s) {
  const v = normDigits(s).trim();
  let y, m, d, x;
  if ((x = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(v))) [d, m, y] = [+x[1], +x[2], +x[3]];
  else return null;
  const t = new Date(y, m - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== m - 1 || t.getDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
const toInt = (v) => {
  const s = normDigits(v).replace(/[$,\s]/g, '');
  if (s === '') return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
};

function hashSecret(secret, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(secret), salt, 32).toString('hex') };
}
function checkSecret(secret, salt, hash) {
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(secret), salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

class AppError extends Error {
  constructor(key, params = {}, status = 400, extra = {}) {
    super(key); this.key = key; this.params = params; this.status = status; Object.assign(this, extra);
  }
}

// ------------------------------------------------------------------ receipts
const FIELDS = ['ReceiptDate', 'CustomerName', 'CustType', 'ApartmentNo', 'Currency',
  'M1', 'Y1', 'A1', 'M2', 'Y2', 'A2', 'M3', 'Y3', 'A3', 'ReceivedBy', 'Notes'];

// client JSON → normalized DB fields. Throws AppError on any rule break.
function validate(inp) {
  const rec = {};
  const dateIn = String(inp.date ?? '').trim();
  rec.ReceiptDate = dateIn ? parseDate(dateIn) : today();
  if (!rec.ReceiptDate) throw new AppError('badDate');
  rec.CustomerName = clean(inp.name, 120);
  rec.CustType = inp.type === 'O' || inp.type === 'T' ? inp.type : null;
  rec.ApartmentNo = normApt(inp.apt);
  rec.Currency = inp.currency === 'IQD' ? 'IQD' : 'USD';
  rec.ReceivedBy = clean(inp.receivedBy, 80);
  rec.Notes = clean(inp.notes, 255);

  const lines = Array.isArray(inp.lines) ? inp.lines : [];
  let full = 0;
  const seen = new Set();
  for (let i = 1; i <= 3; i++) {
    const l = lines[i - 1] || {};
    const m = toInt(l.m), y = toInt(l.y), a = toInt(l.a);
    rec['M' + i] = rec['Y' + i] = rec['A' + i] = null;
    if (m === null && y === null && a === null) continue;               // empty line
    const ok = Number.isInteger(m) && m >= 1 && m <= 12 &&
      Number.isInteger(y) && y >= 2000 && y <= 2100 && Number.isInteger(a) && a > 0;
    if (!ok) throw new AppError('lineIncomplete', { n: i });             // gap fix: month+year+amount together
    const k = `${m}/${y}`;
    if (seen.has(k)) throw new AppError('dupLine', { m, y });             // gap fix: same month twice
    seen.add(k);
    rec['M' + i] = m; rec['Y' + i] = y; rec['A' + i] = a; full++;
  }
  if ((!rec.CustomerName && !rec.ApartmentNo) || full === 0) throw new AppError('needData');
  return rec;
}

const numPart = (no, prefix) => {
  if (!no.startsWith(prefix)) return null;
  const rest = no.slice(prefix.length);
  return /^\d+$/.test(rest) ? parseInt(rest, 10) : null;
};
const formatNo = (prefix, n) => prefix + String(n).padStart(3, '0');

function maxNumber(db, prefix) {
  let max = 0;
  const rows = db.prepare('SELECT ReceiptNo FROM Receipts WHERE substr(ReceiptNo, 1, ?) = ?').all(prefix.length, prefix);
  for (const r of rows) { const n = numPart(r.ReceiptNo, prefix); if (n !== null && n > max) max = n; }
  return max;
}
// §3: n = max(NextNo, highest existing + 1); NextNo = n + 1.  Must run inside tx().
function takeNextNo(db) {
  const s = db.prepare('SELECT Prefix, NextNo FROM Settings WHERE ID = 1').get();
  const n = Math.max(s.NextNo, maxNumber(db, s.Prefix) + 1);
  db.prepare('UPDATE Settings SET NextNo = ? WHERE ID = 1').run(n + 1);
  return formatNo(s.Prefix, n);
}
function peekNextNo(db) {
  const s = db.prepare('SELECT Prefix, NextNo FROM Settings WHERE ID = 1').get();
  return formatNo(s.Prefix, Math.max(s.NextNo, maxNumber(db, s.Prefix) + 1));
}

function audit(db, user, action, r = {}, field = null, oldV = null, newV = null) {
  db.prepare(`INSERT INTO AuditLog (At, UserName, ReceiptID, ReceiptNo, Action, Field, OldValue, NewValue)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(stamp(), user || null, r.ReceiptID ?? null, r.ReceiptNo ?? null, action, field,
      oldV === null || oldV === undefined ? null : String(oldV), newV === null || newV === undefined ? null : String(newV));
}

const total = (r) => (r.A1 || 0) + (r.A2 || 0) + (r.A3 || 0);
function toJson(r) {
  if (!r) return null;
  return {
    id: r.ReceiptID, no: r.ReceiptNo, date: r.ReceiptDate, name: r.CustomerName, type: r.CustType,
    apt: r.ApartmentNo, currency: r.Currency || 'USD', receivedBy: r.ReceivedBy, notes: r.Notes, cancelled: !!r.Cancelled,
    createdAt: r.CreatedAt, updatedAt: r.UpdatedAt, rev: r.Rev, total: total(r),
    lines: [1, 2, 3].map((i) => ({ m: r['M' + i], y: r['Y' + i], a: r['A' + i] })),
  };
}
const getRow = (db, id) => db.prepare('SELECT * FROM Receipts WHERE ReceiptID = ?').get(id);

// other non-voided receipts that already paid the same apartment + month/year
function findDups(db, rec, excludeId) {
  if (!rec.ApartmentNo) return [];
  const q = db.prepare(`SELECT ReceiptNo FROM PaymentLines
     WHERE ApartmentNo = ? COLLATE NOCASE AND M = ? AND Y = ? AND ReceiptID <> ? ORDER BY ReceiptID`);
  const out = [];
  for (let i = 1; i <= 3; i++) {
    if (!rec['M' + i]) continue;
    for (const d of q.all(rec.ApartmentNo, rec['M' + i], rec['Y' + i], excludeId ?? -1))
      out.push({ m: rec['M' + i], y: rec['Y' + i], no: d.ReceiptNo });
  }
  return out;
}
const ensureApartment = (db, apt) => apt && db.prepare('INSERT OR IGNORE INTO Apartments (ApartmentNo) VALUES (?)').run(apt);

function createReceipt(db, inp, user, confirmDup = false) {
  const rec = validate(inp);
  const dups = findDups(db, rec, null);
  if (dups.length && !confirmDup) throw new AppError('dupOther', { apt: rec.ApartmentNo }, 409, { dups });
  const id = tx(db, () => {
    const no = takeNextNo(db);
    const at = stamp();
    const r = db.prepare(`INSERT INTO Receipts (ReceiptNo, ${FIELDS.join(', ')}, Cancelled, CreatedAt, UpdatedAt, CreatedBy)
      VALUES (?, ${FIELDS.map(() => '?').join(', ')}, 0, ?, ?, ?)`)
      .run(no, ...FIELDS.map((f) => rec[f]), at, at, user || null);
    const newId = Number(r.lastInsertRowid);
    audit(db, user, 'create', { ReceiptID: newId, ReceiptNo: no }, null, null, `${total(rec)} ${rec.Currency}`);
    if (dups.length) audit(db, user, 'create', { ReceiptID: newId, ReceiptNo: no }, 'duplicateConfirmed', null,
      dups.map((d) => `${d.m}/${d.y}@${d.no}`).join(', '));
    ensureApartment(db, rec.ApartmentNo);
    return newId;
  });
  return toJson(getRow(db, id));
}

function updateReceipt(db, id, inp, user, confirmDup = false) {
  const old = getRow(db, id);
  if (!old) throw new AppError('notFound', {}, 404);
  if (old.Cancelled) throw new AppError('isVoid');
  if (inp.rev !== undefined && Number(inp.rev) !== old.Rev) throw new AppError('stale', {}, 409);
  const rec = validate(inp);
  const dups = findDups(db, rec, id);
  if (dups.length && !confirmDup) throw new AppError('dupOther', { apt: rec.ApartmentNo }, 409, { dups });
  const changed = FIELDS.filter((f) => (old[f] ?? null) !== (rec[f] ?? null));
  if (!changed.length) return toJson(old);
  tx(db, () => {
    db.prepare(`UPDATE Receipts SET ${changed.map((f) => f + ' = ?').join(', ')}, UpdatedAt = ?, Rev = Rev + 1 WHERE ReceiptID = ?`)
      .run(...changed.map((f) => rec[f]), stamp(), id);
    for (const f of changed) audit(db, user, 'edit', old, f, old[f], rec[f]);
    if (dups.length) audit(db, user, 'edit', old, 'duplicateConfirmed', null, dups.map((d) => `${d.m}/${d.y}@${d.no}`).join(', '));
    ensureApartment(db, rec.ApartmentNo);
  });
  return toJson(getRow(db, id));
}

function voidReceipt(db, id, user) {
  const old = getRow(db, id);
  if (!old) throw new AppError('notFound', {}, 404);
  if (old.Cancelled) throw new AppError('isVoid');
  tx(db, () => {
    db.prepare('UPDATE Receipts SET Cancelled = 1, UpdatedAt = ?, Rev = Rev + 1 WHERE ReceiptID = ?').run(stamp(), id);
    audit(db, user, 'void', old, 'Cancelled', 0, 1);
  });
  return toJson(getRow(db, id));
}

function listReceipts(db) {
  return db.prepare(`SELECT ReceiptID id, ReceiptNo no, ReceiptDate date, CustomerName name, CustType type,
      ApartmentNo apt, Currency cur, Cancelled cancelled, COALESCE(A1,0)+COALESCE(A2,0)+COALESCE(A3,0) total
    FROM Receipts ORDER BY ReceiptID DESC`).all().map((r) => ({ ...r, cancelled: !!r.cancelled }));
}

// ------------------------------------------------------------------ apartments
// name/type from the latest non-voided receipt of each apartment (§2.4)
function latestByApt(db) {
  const m = new Map();
  for (const r of db.prepare(`SELECT ApartmentNo apt, CustomerName name, CustType type, MAX(ReceiptID) id
      FROM Receipts WHERE Cancelled = 0 AND ApartmentNo IS NOT NULL GROUP BY ApartmentNo COLLATE NOCASE`).all())
    m.set(r.apt.toUpperCase(), r);
  return m;
}
function apartments(db) {
  const latest = latestByApt(db);
  const rows = db.prepare('SELECT * FROM Apartments').all();
  return rows.map((a) => {
    const l = latest.get(a.ApartmentNo.toUpperCase());
    return {
      apt: a.ApartmentNo, floor: a.Floor, owner: a.OwnerName, tenant: a.TenantName, phone: a.Phone,
      active: !!a.Active,
      name: (l && l.name) || a.TenantName || a.OwnerName || null,
      type: (l && l.type) || (a.TenantName ? 'T' : a.OwnerName ? 'O' : null),
    };
  }).sort((x, y) => aptCmp(x.apt, y.apt));
}

const curYM = () => { const d = now(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; };
const isFuture = (y, m) => { const c = curYM(); return y > c.y || (y === c.y && m > c.m); };

// Amounts in reports are kept PER CURRENCY ({ USD, IQD }) — never converted or added together.
const CURS = ['USD', 'IQD'];
const money0 = () => ({ USD: 0, IQD: 0 });
const addTo = (o, cur, a) => { o[cur === 'IQD' ? 'IQD' : 'USD'] += a; return o; };
const sumLines = (ls) => ls.reduce((o, l) => addTo(o, l.C, l.A), money0());
const isZero = (o) => !o.USD && !o.IQD;

// §7 apartment report
function aptReport(db, aptIn, yearIn) {
  const apt = normApt(aptIn);
  const all = apartments(db);
  const info = all.find((a) => a.apt.toUpperCase() === (apt || '').toUpperCase());
  const years = db.prepare(`SELECT DISTINCT Y FROM PaymentLines WHERE ApartmentNo = ? COLLATE NOCASE AND Y IS NOT NULL ORDER BY Y DESC`)
    .all(apt || '').map((r) => r.Y);
  const cy = curYM().y;
  let year = Number(yearIn) || null;
  if (!year || !years.includes(year)) year = years.includes(cy) ? cy : (years[0] || cy);
  const lines = db.prepare(`SELECT M m, A a, C c, ReceiptNo no, ReceiptID id, ReceiptDate date FROM PaymentLines
     WHERE ApartmentNo = ? COLLATE NOCASE AND Y = ? ORDER BY M, ReceiptID`).all(apt || '', year);
  const asLines = (ls) => ls.map((l) => ({ A: l.a, C: l.c }));
  const grid = [];
  for (let m = 1; m <= 12; m++) {
    const ls = lines.filter((l) => l.m === m);
    grid.push({ m, amount: sumLines(asLines(ls)), paid: ls.length > 0, state: ls.length ? 'paid' : isFuture(year, m) ? 'future' : 'unpaid' });
  }
  return {
    apt: info ? info.apt : apt, name: info ? info.name : null, years: years.length ? years : [cy], year,
    grid, lines, total: sumLines(asLines(lines)),
  };
}

// denominator for "all apartments": active ones + any that paid in the period
function aptUniverse(db, paidSet) {
  const s = new Set(db.prepare('SELECT ApartmentNo FROM Apartments WHERE Active = 1').all().map((r) => r.ApartmentNo.toUpperCase()));
  for (const a of paidSet) s.add(a);
  return s;
}

// §8 monthly summary
function monthly(db, yearIn) {
  const cy = curYM().y;
  const years = new Set(db.prepare('SELECT DISTINCT Y FROM PaymentLines WHERE Y IS NOT NULL').all().map((r) => r.Y));
  years.add(cy);
  const year = Number(yearIn) || cy;
  years.add(year);
  const yl = db.prepare('SELECT M, A, C, ApartmentNo apt FROM PaymentLines WHERE Y = ?');
  const cur = yl.all(year), prev = yl.all(year - 1);

  const rows = [];
  for (let m = 1; m <= 12; m++) {
    const ls = cur.filter((l) => l.M === m);
    const apts = new Set(ls.filter((l) => l.apt).map((l) => l.apt.toUpperCase()));
    const universe = aptUniverse(db, apts).size;
    rows.push({
      m, amount: sumLines(ls), apts: apts.size, payments: ls.length,
      rate: universe ? apts.size / universe : null,
      prev: sumLines(prev.filter((l) => l.M === m)),
    });
  }
  const totalAmt = sumLines(cur);
  const prevTotal = sumLines(prev);
  const monthsPaid = rows.filter((r) => r.payments > 0).length;
  const avg = money0(), prevPct = { USD: null, IQD: null };
  for (const c of CURS) {
    const months = rows.filter((r) => r.amount[c] > 0).length;       // average over months that had payments in that currency
    avg[c] = months ? Math.round(totalAmt[c] / months) : 0;
    prevPct[c] = prevTotal[c] ? (totalAmt[c] - prevTotal[c]) / prevTotal[c] : null;
  }
  const payingSet = new Set(cur.filter((l) => l.apt).map((l) => l.apt.toUpperCase()));
  const universe = aptUniverse(db, payingSet).size;
  // "best month" and the bars are ranked by the main currency of the year: dollars, unless the year has only dinars
  const main = totalAmt.USD > 0 || !totalAmt.IQD ? 'USD' : 'IQD';
  const best = rows.reduce((b, r) => (r.amount[main] > (b ? b.amount[main] : 0) ? r : b), null);
  const bestAmt = best ? best.amount[main] : 0;
  for (const r of rows) r.bar = bestAmt ? Math.round((r.amount[main] / bestAmt) * 16) : 0;
  return {
    year, years: [...years].sort((a, b) => b - a), currentYear: cy, currentMonth: curYM().m, rows, mainCurrency: main,
    totals: { amount: totalAmt, payments: rows.reduce((s, r) => s + r.payments, 0), prev: prevTotal },
    kpi: {
      total: totalAmt, prevTotal, prevPct, avg, monthsPaid,
      paying: payingSet.size, allApts: universe, payingPct: universe ? payingSet.size / universe : null,
      bestMonth: best ? best.m : null, bestAmount: best ? best.amount : money0(),
    },
  };
}

// §9 apartments of a month
function monthApts(db, yearIn, monthIn) {
  const year = Number(yearIn), month = Number(monthIn);
  const lines = db.prepare('SELECT ApartmentNo apt, A, C, ReceiptNo no, ReceiptID id FROM PaymentLines WHERE Y = ? AND M = ?').all(year, month);
  const info = new Map(apartments(db).map((a) => [a.apt.toUpperCase(), a]));
  const paid = new Map();
  let noApt = null;
  for (const l of lines) {
    if (!l.apt) {
      noApt = noApt || { amount: money0(), count: 0, id: 0, no: null };
      addTo(noApt.amount, l.C, l.A); noApt.count++;
      if (l.id > noApt.id) { noApt.id = l.id; noApt.no = l.no; }
      continue;
    }
    const k = l.apt.toUpperCase();
    const p = paid.get(k) || { apt: l.apt, amount: money0(), id: 0, no: null };
    addTo(p.amount, l.C, l.A);
    if (l.id > p.id) { p.id = l.id; p.no = l.no; }     // highest receipt if several
    paid.set(k, p);
  }
  const rows = [...paid.entries()].map(([k, p]) => ({
    apt: p.apt, name: info.get(k)?.name ?? null, paid: true, amount: p.amount, no: p.no, id: p.id,
  }));
  if (!isFuture(year, month)) {
    for (const a of info.values())
      if (a.active && !paid.has(a.apt.toUpperCase())) rows.push({ apt: a.apt, name: a.name, paid: false, amount: null, no: null, id: null });
  }
  rows.sort((x, y) => (x.paid === y.paid ? aptCmp(x.apt, y.apt) : x.paid ? -1 : 1));
  return {
    year, month, rows, noApt, total: sumLines(lines),
    paidCount: rows.filter((r) => r.paid).length, unpaidCount: rows.filter((r) => !r.paid).length,
  };
}

// ------------------------------------------------------------------ settings / admin
function getSettings(db) { return db.prepare('SELECT * FROM Settings WHERE ID = 1').get(); }

function setBook(db, prefixIn, nextIn, user) {
  const prefix = clean(normDigits(prefixIn), 10);
  const next = toInt(nextIn);
  if (!prefix || !Number.isInteger(next) || next < 1) throw new AppError('badInput');
  const s = getSettings(db);
  tx(db, () => {
    db.prepare('UPDATE Settings SET Prefix = ?, NextNo = ? WHERE ID = 1').run(prefix, next);
    if (s.Prefix !== prefix) audit(db, user, 'settings', {}, 'Prefix', s.Prefix, prefix);
    if (s.NextNo !== next) audit(db, user, 'settings', {}, 'NextNo', s.NextNo, next);
  });
  return { prefix, nextNo: next, preview: peekNextNo(db) };
}

function texts(db) {
  const out = {};
  for (const r of db.prepare('SELECT Key, KU, AR FROM Texts').all()) out[r.Key] = [r.KU, r.AR];
  return out;
}

module.exports = {
  AppError, validate, takeNextNo, peekNextNo, maxNumber, formatNo, numPart, createReceipt, updateReceipt, voidReceipt,
  listReceipts, getRow, toJson, findDups, apartments, aptReport, monthly, monthApts, getSettings, setBook, texts,
  audit, ensureApartment, hashSecret, checkSecret, normApt, normDigits, aptCmp, parseDate, toInt, clean,
  stamp, today, now, FIELDS, total, isZero,
};
