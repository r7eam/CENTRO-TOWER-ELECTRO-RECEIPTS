// Sets a new ADMIN password when the old one is forgotten.
// Works only on the computer that holds the data (it opens data\centro.db directly), never from a phone.
// Receipts and all other data are not touched. Run it by double-clicking tools\reset-admin-password.bat
const path = require('path');
const fs = require('fs');
process.chdir(path.join(__dirname, '..'));
const D = require('../server/db');
const L = require('../server/logic');

// input that is not a keyboard (piped): read it line by line
const pending = [];
let waiter = null;
if (!process.stdin.isTTY) {
  require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
    if (waiter) { const w = waiter; waiter = null; w(l); } else pending.push(l);
  });
}
function ask(question, hidden) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    if (!stdin.isTTY) {
      if (pending.length) resolve(pending.shift()); else waiter = (l) => { process.stdout.write('\n'); resolve(l); };
      return;
    }
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
          process.stdout.write('\n'); resolve(value); return;
        }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(1); }        // Ctrl+C
        if (c === '\u0008' || c === '\u007f') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        value += c; process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  console.log('');
  console.log('  CENTRO TOWER — reset the admin password / إعادة تعيين كلمة مرور المدير');
  console.log(`  Database: ${D.DB_FILE}`);
  console.log('');
  if (!fs.existsSync(D.DB_FILE)) { console.log('  No database found here. Nothing to do.'); return; }
  const db = D.open();
  if (!L.getSettings(db).SetupDone) { console.log('  The system is not set up yet — open it in the browser to set the password.'); return; }
  for (;;) {
    const p1 = await ask('  New admin password / كلمة المرور الجديدة: ', true);
    if (p1.length < 4) { console.log('  At least 4 characters / 4 أحرف على الأقل\n'); continue; }
    const p2 = await ask('  Repeat / أعد كتابتها: ', true);
    if (p1 !== p2) { console.log('  The two passwords are different / غير متطابقتين\n'); continue; }
    const { salt, hash } = L.hashSecret(p1);
    db.prepare('UPDATE Settings SET AdminHash = ?, AdminSalt = ? WHERE ID = 1').run(hash, salt);
    L.audit(db, `Windows: ${process.env.USERNAME || '?'}`, 'settings', {}, 'AdminPassword', null, 'reset with tools\\reset-admin-password');
    db.close();
    console.log('\n  ✓ Done. The new password works immediately (no restart needed).');
    console.log('  ✓ تم. كلمة المرور الجديدة تعمل فوراً.\n');
    process.exit(0);
  }
})();
