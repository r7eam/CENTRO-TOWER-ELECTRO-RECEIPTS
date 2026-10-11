// Second backup location(s): every backup made in data\backups is also copied to the folders chosen in
// Settings (another disk, a USB stick, a OneDrive / Google Drive folder), together with an Excel file
// of all receipts that opens without this program. A folder that is not reachable (USB unplugged) is
// retried every few minutes, so copies catch up as soon as it is plugged in again.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const D = require('./db');
const L = require('./logic');
const { toXlsx } = require('./export');

const KEEP_AUTO = 60;                          // daily copies kept in each mirror folder
const XLSX_NAME = 'centro-receipts-latest.xlsx';

function getDirs(db) {
  try { return JSON.parse(L.getSettings(db).MirrorDirs || '[]'); } catch { return []; }
}
function getStatus(db) {
  try { return JSON.parse(L.getSettings(db).MirrorStatus || '{}'); } catch { return {}; }
}
function saveStatus(db, st) {
  db.prepare('UPDATE Settings SET MirrorStatus = ? WHERE ID = 1').run(JSON.stringify(st));
}

// check a folder the user typed; returns the cleaned absolute path or throws AppError
function checkDir(dir) {
  const d = String(dir || '').trim().replace(/[\\/]+$/, '');
  if (!/^[a-zA-Z]:\\/.test(d.replace(/\//g, '\\')) && !d.startsWith('\\\\')) throw new L.AppError('badDir', { dir: d || '-' });
  const abs = path.resolve(d);
  const data = path.resolve(D.DATA_DIR);
  if (abs.toLowerCase() === data.toLowerCase() || abs.toLowerCase().startsWith(data.toLowerCase() + path.sep)) throw new L.AppError('sameAsData');
  return abs;
}

function errInfo(e, dir) {
  const root = path.parse(dir).root;
  if (!fs.existsSync(root)) return { code: 'mirrorNoDrive', msg: root };
  if (e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) return { code: 'dirNotWritable', msg: dir };
  return { code: 'errServer', msg: (e && e.message) || String(e) };
}

// copy one backup file (by name, from data\backups) to every mirror folder; also refresh the Excel copy
function mirrorFile(db, name) {
  const dirs = getDirs(db);
  if (!dirs.length) return {};
  const st = getStatus(db);
  let xlsx = null;
  for (const dir of dirs) {
    const s = st[dir] || {};
    try {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, name);
      fs.copyFileSync(path.join(D.BACKUP_DIR, name), target + '.part');
      fs.renameSync(target + '.part', target);
      xlsx = xlsx || toXlsx(db);
      fs.writeFileSync(path.join(dir, XLSX_NAME), xlsx);
      // keep the newest KEEP_AUTO daily copies (only files this program made)
      const autos = fs.readdirSync(dir).filter((f) => /^auto_\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse();
      for (const f of autos.slice(KEEP_AUTO)) fs.unlinkSync(path.join(dir, f));
      s.lastOk = L.stamp(); s.lastFile = name; s.error = null;
    } catch (e) {
      s.error = { ...errInfo(e, dir), at: L.stamp() };
    }
    st[dir] = s;
  }
  saveStatus(db, st);
  return st;
}

// copy the newest local backup to any mirror folder that does not have it yet (e.g. USB plugged back in)
function catchUp(db) {
  const dirs = getDirs(db);
  if (!dirs.length || !fs.existsSync(D.BACKUP_DIR)) return;
  const local = fs.readdirSync(D.BACKUP_DIR).filter((f) => f.endsWith('.db'))
    .map((f) => ({ f, t: fs.statSync(path.join(D.BACKUP_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  if (!local) return;
  const missing = dirs.some((dir) => {
    try { return !fs.existsSync(path.join(dir, local.f)); } catch { return true; }
  });
  if (missing) mirrorFile(db, local.f);
}

// warning for the header: null when everything is fine
function warning(db) {
  const dirs = getDirs(db);
  if (!dirs.length) return { key: 'warnNoMirror' };
  const st = getStatus(db);
  const last = dirs.map((d) => st[d] && st[d].lastOk).filter(Boolean).sort().pop();
  if (!last) return { key: 'warnMirrorNever' };
  const days = Math.floor((L.now() - new Date(last.replace(' ', 'T'))) / 86400000);
  return days >= 3 ? { key: 'warnMirrorOld', params: { d: days } } : null;
}

// ready-made suggestions: other fixed disks, USB sticks, OneDrive / Google Drive folders
function suggestions() {
  return new Promise((resolve) => {
    const out = [];
    const dataDrive = path.parse(path.resolve(D.DATA_DIR)).root.slice(0, 2).toUpperCase();
    const add = (kind, dir) => { if (!out.some((s) => s.dir.toLowerCase() === dir.toLowerCase())) out.push({ kind, dir }); };
    for (const p of [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial])
      if (p && fs.existsSync(p)) add('sugCloud', path.join(p, 'CentroTower-Backup'));
    for (const p of [path.join(process.env.USERPROFILE || '', 'Google Drive'), 'G:\\My Drive'])
      if (fs.existsSync(p)) add('sugCloud', path.join(p, 'CentroTower-Backup'));
    execFile('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, DriveType | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      try {
        let disks = JSON.parse(stdout || '[]');
        if (!Array.isArray(disks)) disks = [disks];
        for (const d of disks) {
          if (d.DeviceID.toUpperCase() === dataDrive) continue;
          if (d.DriveType === 2) add('sugUsb', `${d.DeviceID}\\CentroTower-Backup`);
          if (d.DriveType === 3) add('sugDisk', `${d.DeviceID}\\CentroTower-Backup`);
        }
      } catch { /* no suggestions from disks */ }
      resolve(out);
    });
  });
}

module.exports = { getDirs, getStatus, checkDir, mirrorFile, catchUp, warning, suggestions, XLSX_NAME };
