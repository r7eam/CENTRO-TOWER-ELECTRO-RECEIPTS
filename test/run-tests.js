// End-to-end tests against a throw-away database.  Run:  npm test
// Optional: node test/run-tests.js "path\to\file.accdb"  → also tests the Access import.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 3999;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'centro-test-'));
const BASE = `http://127.0.0.1:${PORT}`;
let token, admin, failures = 0, passes = 0;

function ok(cond, msg) { if (cond) { passes++; console.log('  ✓ ' + msg); } else { failures++; console.log('  ✗ ' + msg); } }
async function call(method, url, body, headers = {}) {
  const h = { ...headers };
  if (token) h['X-Token'] = token;
  if (admin) h['X-Admin'] = admin;
  let payload = body;
  if (body !== undefined && !(body instanceof Buffer)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + url, { method, headers: h, body: payload });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}
const line = (m, y, a) => ({ m, y, a });
const zero = () => ({ USD: 0, IQD: 0 });
const addM = (...os) => os.reduce((t, o) => ({ USD: t.USD + o.USD, IQD: t.IQD + o.IQD }), zero());
const same = (a, b) => a.USD === b.USD && a.IQD === b.IQD;
const rc = (o) => ({ date: '11/10/2026', name: 'Test', type: 'O', apt: '1', lines: [], receivedBy: 'Ali', notes: '', ...o });

async function main() {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')],
    { env: { ...process.env, PORT: String(PORT), CENTRO_DATA: DATA, CENTRO_TODAY: '2026-10-11' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => { if (String(d).includes('localhost')) r(); }));
  try {
    console.log('\nsetup / login');
    let r = await call('POST', '/api/setup', { userName: 'Ali', prefix: '01-', startNo: '21', adminPassword: 'secret1', lang: 'ku' });
    ok(r.status === 200 && r.data.token, 'first setup creates user + session');
    token = r.data.token;
    r = await call('POST', '/api/setup', { userName: 'X', adminPassword: 'abcd' });
    ok(r.status === 403, 'setup cannot run twice');
    r = await call('GET', '/api/receipts', undefined, { 'X-Token': 'bad' });
    ok(r.status === 401 || r.status === 200, 'bad token handled');

    console.log('\nvalidation (§4, §13)');
    r = await call('POST', '/api/receipts', { receipt: rc({ name: '', apt: '', lines: [line(1, 2026, 25)] }) });
    ok(r.data.error === 'needData', 'no name and no apartment → needData');
    r = await call('POST', '/api/receipts', { receipt: rc({ lines: [] }) });
    ok(r.data.error === 'needData', 'no payment line → needData');
    r = await call('POST', '/api/receipts', { receipt: rc({ lines: [line(5, '', 25)] }) });
    ok(r.data.error === 'lineIncomplete' && r.data.params.n === 1, 'month+amount without year → lineIncomplete (gap fix)');
    r = await call('POST', '/api/receipts', { receipt: rc({ lines: [line(5, 2026, 25), line(6, 2026, 0)] }) });
    ok(r.data.error === 'lineIncomplete' && r.data.params.n === 2, 'amount 0 → lineIncomplete');
    r = await call('POST', '/api/receipts', { receipt: rc({ lines: [line(5, 2026, 25), line(5, 2026, 25)] }) });
    ok(r.data.error === 'dupLine', 'same month twice on one receipt → blocked');
    r = await call('POST', '/api/receipts', { receipt: rc({ date: '31/02/2026', lines: [line(5, 2026, 25)] }) });
    ok(r.data.error === 'badDate', 'impossible date → badDate');
    r = await call('GET', '/api/bootstrap');
    ok(r.data.preview === '01-021', 'failed saves used no number (next is still 01-021)');

    console.log('\nnumbering (§3)');
    r = await call('POST', '/api/receipts', { receipt: rc({ apt: '١٢', lines: [line(12, 2025, 25), line(1, 2026, 25)] }) });
    ok(r.data.no === '01-021', 'first receipt gets the start number 01-021');
    ok(r.data.apt === '12', 'Arabic digits normalised (١٢ → 12)');
    ok(r.data.total === 50, 'total = 50 across two years');
    const first = r.data;
    const many = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      call('POST', '/api/receipts', { receipt: rc({ apt: String(100 + i), lines: [line(1, 2026, 10 + i)] }) })));
    const nos = many.map((x) => x.data.no);
    ok(many.every((x) => x.status === 200), '40 concurrent saves all succeed');
    ok(new Set(nos).size === 40, 'concurrent saves → 40 unique numbers');
    const nums = nos.map((n) => +n.slice(3)).sort((a, b) => a - b);
    ok(nums[0] === 22 && nums[39] === 61, 'numbers are contiguous 022…061 (no gaps)');

    console.log('\nduplicates across receipts (§13)');
    r = await call('POST', '/api/receipts', { receipt: rc({ apt: '12', lines: [line(1, 2026, 25)] }) });
    ok(r.status === 409 && r.data.error === 'dupOther' && r.data.dups[0].no === '01-021', 'same apt+month on another receipt → warning with receipt no');
    r = await call('POST', '/api/receipts', { receipt: rc({ apt: '12', lines: [line(1, 2026, 25)] }), confirmDup: true });
    ok(r.status === 200 && r.data.no === '01-062', 'user confirms → saved');
    const dupRec = r.data;

    console.log('\nedit / void / audit');
    r = await call('PUT', `/api/receipts/${first.id}`, { receipt: { ...rc({ apt: '12', name: 'Kawa', lines: [line(12, 2025, 25), line(1, 2026, 30)] }), rev: first.rev } });
    ok(r.data.error === 'dupOther', 'editing into a month paid on another receipt → warning too');
    r = await call('POST', `/api/receipts/${dupRec.id}/void`);
    ok(r.status === 200 && r.data.cancelled, 'void works');
    r = await call('PUT', `/api/receipts/${first.id}`, { receipt: { ...rc({ apt: '12', name: 'Kawa', lines: [line(12, 2025, 25), line(1, 2026, 30)] }), rev: first.rev } });
    ok(r.status === 200 && r.data.total === 55 && r.data.no === '01-021', 'edit keeps number, changes total');
    r = await call('PUT', `/api/receipts/${first.id}`, { receipt: { ...rc({ apt: '12' , lines: [line(1, 2026, 30)] }), rev: first.rev } });
    ok(r.data.error === 'stale', 'edit based on an old copy → stale (two users editing)');
    r = await call('POST', `/api/receipts/${dupRec.id}/void`);
    ok(r.data.error === 'isVoid', 'void twice → isVoid');
    r = await call('PUT', `/api/receipts/${dupRec.id}`, { receipt: rc({ lines: [line(2, 2026, 5)] }) });
    ok(r.data.error === 'isVoid', 'voided receipt cannot be edited');
    r = await call('POST', '/api/admin/unlock', { password: 'wrong' });
    ok(r.status === 401, 'wrong admin password refused');
    r = await call('GET', '/api/admin/audit');
    ok(r.status === 403, 'audit log needs admin');
    r = await call('POST', '/api/admin/unlock', { password: 'secret1' });
    admin = r.data.adminToken;
    r = await call('GET', '/api/admin/audit');
    const edits = r.data.filter((a) => a.Action === 'edit' && a.ReceiptNo === '01-021');
    ok(edits.some((a) => a.Field === 'CustomerName' && a.OldValue === 'Test' && a.NewValue === 'Kawa' && a.UserName === 'Ali'), 'audit: who / old → new for edits');
    ok(r.data.some((a) => a.Action === 'void' && a.ReceiptNo === '01-062'), 'audit: void recorded');

    console.log('\nreports agree (§2.4, §7, §8, §9)');
    await call('POST', '/api/receipts', { receipt: rc({ apt: '', name: 'Walk-in', lines: [line(1, 2026, 7)] }) });
    await call('POST', '/api/admin/apartments', { apt: '7B', owner: 'Owner Seven' });
    const mon = (await call('GET', '/api/reports/monthly?year=2026')).data;
    const jan = (await call('GET', '/api/reports/month?year=2026&month=1')).data;
    const janRow = mon.rows[0];
    ok(same(janRow.amount, jan.total), `monthly Jan amount (${JSON.stringify(janRow.amount)}) = month pop-up total (${JSON.stringify(jan.total)})`);
    const sumApt = addM(...jan.rows.filter((x) => x.paid).map((x) => x.amount), jan.noApt ? jan.noApt.amount : zero());
    ok(same(sumApt, jan.total), 'pop-up rows + no-apartment row add up to the total');
    ok(janRow.apts === jan.paidCount, 'monthly "apartments" = pop-up paid count');
    ok(!jan.rows.some((x) => x.no === '01-062'), 'voided receipt excluded from reports');
    ok(jan.rows.some((x) => x.apt === '7B' && !x.paid), 'apartment that never paid appears as unpaid (Apartments list)');
    const apt12 = (await call('GET', '/api/reports/apartment?apt=12')).data;
    ok(apt12.year === 2026 && same(apt12.total, { USD: 30, IQD: 0 }) && apt12.name === 'Kawa', 'apartment report: year 2026, total 30, current name');
    ok(apt12.grid[0].state === 'paid' && apt12.grid[1].state === 'unpaid' && apt12.grid[10].state === 'future', 'grid: paid / X / future');
    ok(apt12.years.join() === '2026,2025', 'apartment years = only years with payments');
    const yearSum = (await Promise.all(mon.rows.map((x) => call('GET', `/api/reports/month?year=2026&month=${x.m}`))));
    ok(same(addM(...yearSum.map((x) => x.data.total)), mon.kpi.total), 'sum of 12 pop-ups = year KPI total');
    ok(mon.kpi.monthsPaid === 1 && mon.kpi.bestMonth === 1, 'KPIs: months with payments, best month');
    const fut = (await call('GET', '/api/reports/month?year=2026&month=12')).data;
    ok(fut.unpaidCount === 0, 'future month lists no unpaid apartments');
    ok(same(mon.kpi.prevTotal, { USD: 25, IQD: 0 }), 'previous year total (Dec 2025 line) = 25');

    console.log('\ncurrency (USD / IQD)');
    r = await call('POST', '/api/receipts', { receipt: rc({ apt: '50', currency: 'IQD', lines: [line(1, 2026, 37500), line(2, 2026, 37500)] }) });
    ok(r.status === 200 && r.data.currency === 'IQD' && r.data.total === 75000, 'dinar receipt saved: 75,000 IQD');
    const iqdRec = r.data;
    r = await call('POST', '/api/receipts', { receipt: rc({ apt: '51', lines: [line(1, 2026, 25)] }) });
    ok(r.data.currency === 'USD', 'currency defaults to USD');
    const mon2 = (await call('GET', '/api/reports/monthly?year=2026')).data;
    const jan2 = (await call('GET', '/api/reports/month?year=2026&month=1')).data;
    ok(mon2.rows[0].amount.IQD === 37500 && mon2.rows[0].amount.USD === janRow.amount.USD + 25, 'January keeps dollars and dinars apart (not added together)');
    ok(same(mon2.rows[0].amount, jan2.total), 'monthly = pop-up, per currency');
    ok(mon2.kpi.total.IQD === 75000 && mon2.kpi.avg.IQD === 37500, 'year total + average per currency');
    ok(jan2.rows.find((x) => x.apt === '50').amount.IQD === 37500, 'pop-up shows the dinar amount for apt 50');
    const a50 = (await call('GET', '/api/reports/apartment?apt=50')).data;
    ok(same(a50.total, { USD: 0, IQD: 75000 }) && a50.lines[0].c === 'IQD', 'apartment report in dinars');
    r = await call('PUT', `/api/receipts/${iqdRec.id}`, { receipt: { ...rc({ apt: '50', currency: 'USD', lines: [line(1, 2026, 25), line(2, 2026, 25)] }), rev: iqdRec.rev } });
    ok(r.data.currency === 'USD', 'currency can be changed by editing');
    r = await call('GET', '/api/admin/audit?q=' + encodeURIComponent(iqdRec.no));
    ok(r.data.some((a) => a.Field === 'Currency' && a.OldValue === 'IQD' && a.NewValue === 'USD'), 'currency change is in the edit history');

    console.log('\nsettings');
    r = await call('PUT', '/api/admin/book', { prefix: '02-', nextNo: 1 });
    ok(r.data.preview === '02-001', 'new prefix 02- starts at 02-001');
    r = await call('POST', '/api/receipts', { receipt: rc({ apt: '3', lines: [line(2, 2026, 25)] }) });
    ok(r.data.no === '02-001', 'next receipt uses the new prefix');
    await call('PUT', '/api/admin/book', { prefix: '01-', nextNo: 5 });
    r = await call('GET', '/api/bootstrap');
    ok(r.data.preview === '01-066', 'back to 01- with a too-small NextNo → continues after highest (01-066)');

    console.log('\nimport CSV (§11)');
    const csv = 'ReceiptNo,ReceiptDate,CustomerName,CustType,ApartmentNo,M1,Y1,A1,M2,Y2,A2,M3,Y3,A3,ReceivedBy,Notes,Cancelled,CreatedAt,Currency\r\n' +
      '01-100,05/03/2025,Hama,کرێچی,20,3,2025,25,,,,,,,Ali,,False,2025-03-05 10:11:12\r\n' +
      '01-101,2025-03-06,"Sara, Ahmad",O,21,3,2025,25.5,4,,25,,,,Ali,"note ""x""",True,\r\n' +
      '01-102,2025-03-07,Dinar,O,25,3,2025,25000,,,,,,,Ali,,False,,د.ع\r\n' +
      '01-021,2025-03-06,Dup,O,22,3,2025,25,,,,,,,Ali,,False,\r\n' +
      ',2025-03-06,NoNumber,O,23,3,2025,25,,,,,,,Ali,,False,\r\n' +
      '01-100,2025-03-06,DupInFile,O,24,3,2025,25,,,,,,,Ali,,False,\r\n';
    r = await call('POST', '/api/admin/import?name=old.csv', Buffer.from('﻿' + csv, 'utf8'));
    ok(r.status === 200 && r.data.imported === 3, 'imported 3 receipts');
    ok(r.data.skipped.map((x) => x.reason).sort().join() === 'impDupInFile,impDupNo,impNoNumber', 'skipped 3 with reasons');
    ok(r.data.warnings.some((w) => w.key === 'impNoYear') && r.data.warnings.some((w) => w.key === 'impFraction'), 'warnings: missing year, fraction');
    ok(r.data.nextNo === '01-103', 'numbering continues after highest imported (01-103)');
    ok((await call('GET', '/api/receipts')).data.find((x) => x.no === '01-102').cur === 'IQD', 'CSV currency د.ع → IQD');
    const list = (await call('GET', '/api/receipts')).data;
    const h = list.find((x) => x.no === '01-100');
    ok(h && h.type === 'T' && h.date === '2025-03-05', 'Kurdish CustType → T, dd/mm/yyyy date kept');
    ok(list.find((x) => x.no === '01-101').cancelled === true, 'Cancelled flag kept');

    console.log('\nexport + backup');
    r = await call('GET', '/api/admin/export.csv');
    ok(r.status === 200 && r.data.toString('utf8').includes('01-021'), 'CSV export');
    const exported = r.data;
    ok(exported.toString('utf8').includes(',11/10/2026,'), 'CSV export dates are dd/mm/yyyy');
    ok(exported.toString('utf8').split('\r\n')[0].includes(',Currency,'), 'CSV export has a Currency column');
    const before = (await call('GET', '/api/receipts')).data.length;
    r = await call('POST', '/api/admin/import?name=roundtrip.csv', exported);
    ok(r.status === 200 && r.data.imported === 0 && r.data.skipped.length === before && r.data.skipped.every((x) => x.reason === 'impDupNo'),
      'exported CSV reads back (every row recognised as already present)');
    r = await call('GET', '/api/admin/export.xlsx');
    ok(r.status === 200 && r.data[0] === 0x50 && r.data[1] === 0x4b, 'XLSX export is a zip');
    fs.writeFileSync(path.join(DATA, 'export.xlsx'), r.data);
    r = await call('POST', '/api/admin/backup');
    ok(r.status === 200 && fs.existsSync(path.join(DATA, 'backups', r.data.file)), 'backup file created');

    const users = (await call('GET', '/api/admin/users')).data;
    r = await call('PUT', `/api/admin/users/${users[0].id}`, { active: false });
    ok(r.data.error === 'lastUser', 'the last active user cannot be deactivated (no lock-out)');

    console.log('\nsecond backup folder');
    r = await call('GET', '/api/bootstrap');
    ok(r.data.backupWarning && r.data.backupWarning.key === 'warnNoMirror', 'warning shown while no outside backup is set');
    r = await call('PUT', '/api/admin/mirror', { dirs: ['relative\\folder'] });
    ok(r.data.error === 'badDir', 'incomplete folder path refused');
    r = await call('PUT', '/api/admin/mirror', { dirs: [path.join(DATA, 'backups', 'x')] });
    ok(r.data.error === 'sameAsData', 'folder inside the data folder refused');
    const mdir = path.join(os.tmpdir(), `centro-mirror-${Date.now()}`);
    r = await call('PUT', '/api/admin/mirror', { dirs: [mdir, 'Q:\\CentroTower-Backup'] });
    ok(r.status === 200 && r.data.dirs.length === 2, 'two folders saved (one on a drive that is not plugged in)');
    const mfiles = fs.readdirSync(mdir);
    ok(mfiles.some((f) => /^centro_.*\.db$/.test(f)) && mfiles.includes('centro-receipts-latest.xlsx'), 'backup + Excel copied to the second folder');
    ok(r.data.status[mdir].lastOk && !r.data.status[mdir].error, 'status: copied OK');
    ok(r.data.status['Q:\\CentroTower-Backup'].error.code === 'mirrorNoDrive', 'unplugged drive reported, not fatal');
    ok(r.data.warning === null, 'no warning once a copy outside succeeded');
    const copied = new DatabaseSync(path.join(mdir, mfiles.find((f) => f.endsWith('.db'))), { readOnly: true });
    ok(copied.prepare('SELECT COUNT(*) n FROM Receipts').get().n > 40, 'the copied file is a complete, readable database');
    copied.close();
    fs.rmSync(mdir, { recursive: true, force: true });

    console.log('\nadmin password reset tool');
    const { execFileSync } = require('child_process');
    const outTxt = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'tools', 'reset-admin-password.js'), `--data=${DATA}`],
      { input: 'ab\nnew-pass-9\nnew-pass-9\n', encoding: 'utf8', timeout: 30000 });
    ok(outTxt.includes('Done'), 'tool sets a new password (too-short first try is refused)');
    admin = null;
    r = await call('POST', '/api/admin/unlock', { password: 'secret1' });
    ok(r.status === 401, 'old password no longer works');
    r = await call('POST', '/api/admin/unlock', { password: 'new-pass-9' });
    ok(r.status === 200, 'new password works without restarting');
    admin = r.data.adminToken;

    console.log('\nprotection');
    // (DatabaseSync is required at the top)
    const raw = new DatabaseSync(path.join(DATA, 'centro.db'));
    let blocked = false;
    try { raw.exec('DELETE FROM Receipts'); } catch { blocked = true; }
    ok(blocked, 'database refuses to delete receipts');
    blocked = false;
    try { raw.exec("UPDATE Receipts SET ReceiptNo = '99-999' WHERE ReceiptNo = '01-021'"); } catch { blocked = true; }
    ok(blocked, 'database refuses to change a receipt number');
    blocked = false;
    try { raw.exec("UPDATE Receipts SET Cancelled = 0 WHERE ReceiptNo = '01-062'"); } catch { blocked = true; }
    ok(blocked, 'database refuses to un-void');
    raw.close();

    console.log('\nupgrade of an existing database');
    const oldFile = path.join(DATA, 'old-version.db');
    const old = new DatabaseSync(oldFile);
    old.exec(`CREATE TABLE Receipts (ReceiptID INTEGER PRIMARY KEY AUTOINCREMENT, ReceiptNo TEXT NOT NULL UNIQUE, ReceiptDate TEXT,
      CustomerName TEXT, CustType TEXT, ApartmentNo TEXT, M1 INTEGER, Y1 INTEGER, A1 INTEGER, M2 INTEGER, Y2 INTEGER, A2 INTEGER,
      M3 INTEGER, Y3 INTEGER, A3 INTEGER, ReceivedBy TEXT, Notes TEXT, Cancelled INTEGER NOT NULL DEFAULT 0, CreatedAt TEXT NOT NULL,
      UpdatedAt TEXT, CreatedBy TEXT);
      CREATE VIEW PaymentLines AS SELECT ReceiptID, M1 AS M, Y1 AS Y, A1 AS A FROM Receipts;
      INSERT INTO Receipts (ReceiptNo, ApartmentNo, M1, Y1, A1, CreatedAt) VALUES ('01-001', '5', 3, 2026, 25, '2026-03-01 10:00:00');`);
    old.close();
    const upgraded = require('../server/db').open(oldFile);
    const row = upgraded.prepare('SELECT Currency, Rev FROM Receipts').get();
    const pl = upgraded.prepare('SELECT C, A FROM PaymentLines').get();
    ok(row.Currency === 'USD' && row.Rev === 0 && pl.C === 'USD' && pl.A === 25, 'old receipts become USD, reports keep working');
    upgraded.close();

    const accdb = process.argv[2];
    if (accdb) {
      console.log('\nimport Access');
      r = await call('POST', `/api/admin/import?name=${encodeURIComponent(path.basename(accdb))}`, fs.readFileSync(accdb));
      console.log('    ' + JSON.stringify({ imported: r.data.imported, skipped: r.data.skipped, warnings: r.data.warnings, next: r.data.nextNo, err: r.data.error, p: r.data.params }));
      ok(r.status === 200 && r.data.imported >= 0, 'Access import ran');
      const imp = (await call('GET', '/api/receipts')).data.find((x) => x.no === '01-200');
      if (imp) ok(imp.name === 'ئاراس' && imp.total === 50 && imp.date === '2026-05-03', 'Access row kept Kurdish name, amounts, date');
    }
  } finally {
    srv.kill();
  }
  console.log(`\n${passes} passed, ${failures} failed   (test data in ${DATA})`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
