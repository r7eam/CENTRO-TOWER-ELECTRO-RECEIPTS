// §11 Import receipts from the old Access file (.accdb/.mdb) or from a CSV export of table Receipts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { tx } = require('./db');
const L = require('./logic');

// ---- CSV (RFC 4180, comma or semicolon, UTF-8 with or without BOM)
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// ---- Access, through the Windows Access database engine (ACE OLEDB) via PowerShell
function readAccess(file) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `centro-import-${process.pid}-${Date.now()}.json`);
    const script = path.join(__dirname, '..', 'tools', 'read-accdb.ps1');
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, file, out],
      { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
        // the Access engine can crash PowerShell on shutdown AFTER the data was written,
        // so a finished output file counts as success whatever the exit code
        if (!fs.existsSync(out)) {
          try { fs.unlinkSync(out + '.part'); } catch { /* none */ }
          const msg = (stderr || stdout || (err && err.message) || 'unknown error').trim().split('\n').filter(Boolean);
          return reject(new Error(msg.slice(-3).join(' ')));
        }
        try {
          const rows = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^﻿/, '') || '[]');
          resolve(Array.isArray(rows) ? rows : [rows]);
        } catch (e) { reject(e); } finally { try { fs.unlinkSync(out); } catch { /* none */ } }
      });
  });
}

const TYPE_MAP = { o: 'O', t: 'T', 'خاوەن': 'O', 'مالك': 'O', 'owner': 'O', 'کرێچی': 'T', 'مستأجر': 'T', 'tenant': 'T' };
const truthy = (v) => ['true', '1', '-1', 'yes', 'y', 'نعم', 'بەڵێ'].includes(String(v ?? '').trim().toLowerCase());

// one source row → { rec, warnings } or { skip }
function normalizeRow(raw) {
  const get = (k) => {
    const key = Object.keys(raw).find((x) => x.toLowerCase() === k.toLowerCase());
    const v = key === undefined ? null : raw[key];
    return v === undefined || v === null || String(v).trim() === '' ? null : v;
  };
  const no = L.clean(L.normDigits(get('ReceiptNo')), 20);
  if (!no) return { skip: 'impNoNumber' };
  if (String(get('Notes') || '').trim() === 'Example - delete me') return { skip: 'impExample', no };
  const warnings = [];
  const rec = {
    ReceiptNo: no,
    ReceiptDate: get('ReceiptDate') ? L.parseDate(String(get('ReceiptDate'))) : null,
    CustomerName: L.clean(get('CustomerName'), 120),
    CustType: TYPE_MAP[String(get('CustType') || '').trim().toLowerCase()] || null,
    ApartmentNo: L.normApt(get('ApartmentNo')),
    // the old Access file has no currency column → dollars; CSV may say IQD / دينار / د.ع
    Currency: /^(iqd|د\.?ع|دينار|دینار|dinar)/i.test(String(get('Currency') || '').trim()) ? 'IQD' : 'USD',
    ReceivedBy: L.clean(get('ReceivedBy'), 80),
    Notes: L.clean(get('Notes'), 255),
    Cancelled: truthy(get('Cancelled')) ? 1 : 0,
  };
  const created = get('CreatedAt');
  const cd = created ? L.parseDate(String(created)) : null;
  const ct = created ? /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(created)) : null;
  rec.CreatedAt = cd ? `${cd} ${ct ? `${ct[1].padStart(2, '0')}:${ct[2]}:${ct[3] || '00'}` : '00:00:00'}`
    : rec.ReceiptDate ? `${rec.ReceiptDate} 00:00:00` : L.stamp();
  for (let i = 1; i <= 3; i++) {
    let m = L.toInt(get('M' + i)), y = L.toInt(get('Y' + i)), a = L.toInt(get('A' + i));
    if (Number.isNaN(m) || (m !== null && !(Number.isInteger(m) && m >= 1 && m <= 12))) {
      warnings.push(['impBadMonth', { n: i, v: get('M' + i) }]); m = null;
    }
    if (Number.isNaN(y) || (y !== null && !Number.isInteger(y))) y = null;
    if (Number.isNaN(a)) a = null;
    if (a !== null && !Number.isInteger(a)) { warnings.push(['impFraction', { n: i, v: a }]); a = Math.round(a); }
    if (m !== null && y === null) warnings.push(['impNoYear', { n: i }]);
    rec['M' + i] = m; rec['Y' + i] = y; rec['A' + i] = a;
  }
  return { rec, warnings };
}

function importRows(db, rows, user, source) {
  const result = { imported: 0, skipped: [], warnings: [] };
  const exists = db.prepare('SELECT 1 FROM Receipts WHERE ReceiptNo = ?');
  const seen = new Set();
  const cols = ['ReceiptNo', ...L.FIELDS, 'Cancelled', 'CreatedAt'];
  const ins = db.prepare(`INSERT INTO Receipts (${cols.join(', ')}, UpdatedAt, CreatedBy) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`);
  // keep original order (oldest first) so "newest first" stays right
  const sorted = [...rows].sort((a, b) => (Number(a.ReceiptID) || 0) - (Number(b.ReceiptID) || 0));
  tx(db, () => {
    sorted.forEach((raw, idx) => {
      const rowNo = idx + 1;
      let n;
      try { n = normalizeRow(raw); } catch { n = { skip: 'impBadRow' }; }
      if (n.skip) { result.skipped.push({ row: rowNo, no: n.no || null, reason: n.skip }); return; }
      const { rec } = n;
      if (seen.has(rec.ReceiptNo.toUpperCase())) { result.skipped.push({ row: rowNo, no: rec.ReceiptNo, reason: 'impDupInFile' }); return; }
      if (exists.get(rec.ReceiptNo)) { result.skipped.push({ row: rowNo, no: rec.ReceiptNo, reason: 'impDupNo' }); return; }
      seen.add(rec.ReceiptNo.toUpperCase());
      ins.run(...cols.map((c) => rec[c] ?? null), rec.CreatedAt, user ? `import: ${user}` : 'import');
      L.ensureApartment(db, rec.ApartmentNo);
      result.imported++;
      for (const [key, params] of n.warnings) result.warnings.push({ row: rowNo, no: rec.ReceiptNo, key, params });
    });
    // continue numbering after the highest imported number of the current prefix
    const s = L.getSettings(db);
    const next = Math.max(s.NextNo, L.maxNumber(db, s.Prefix) + 1);
    db.prepare('UPDATE Settings SET NextNo = ? WHERE ID = 1').run(next);
    L.audit(db, user, 'import', {}, source, null, `${result.imported} imported, ${result.skipped.length} skipped`);
  });
  result.nextNo = L.peekNextNo(db);
  return result;
}

async function importFile(db, file, originalName, user) {
  const ext = path.extname(originalName || file).toLowerCase();
  let rows;
  if (ext === '.accdb' || ext === '.mdb') rows = await readAccess(file);
  else if (ext === '.csv' || ext === '.txt') rows = parseCsv(fs.readFileSync(file, 'utf8'));
  else throw new L.AppError('badFile', { ext });
  return importRows(db, rows, user, path.basename(originalName || file));
}

module.exports = { parseCsv, readAccess, normalizeRow, importRows, importFile };
