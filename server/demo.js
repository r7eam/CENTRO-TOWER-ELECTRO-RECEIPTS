// Sample data for DEMO mode only (node server.js --demo). Fake names — never real customers.
const L = require('./logic');
const { tx } = require('./db');

const DEMO_PASSWORD = 'demo1234';
const NAMES = [
  ['ئاراس محەمەد', 'O'], ['سارا عەلی', 'T'], ['هێمن کەریم', 'O'], ['دلێر ئەحمەد', 'T'], ['ڕێژنە حەسەن', 'O'], ['بەختیار عومەر', 'O'],
  ['ژیان قادر', 'T'], ['گۆران ڕەشید', 'O'], ['شادی ئیبراهیم', 'T'], ['کامەران سەعید', 'O'], ['أحمد جاسم', 'O'], ['زينب حسين', 'T'],
  ['محمد كاظم', 'O'], ['نور الهدى', 'T'], ['علي عبدالله', 'O'], ['سلوى محمود', 'T'], ['هاوکار جەلال', 'O'], ['ئاڤان ئازاد', 'T'],
  ['شڤان مستەفا', 'O'], ['لانە ڕزگار', 'T'], ['کاروان سەردار', 'O'], ['مريم يوسف', 'T'], ['حسن فاضل', 'O'], ['پەیمان خالید', 'O'],
];
// small deterministic random generator, so every restart shows the same demo data
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function seed(db) {
  const rand = rng(2026);
  const today = L.now();
  const cy = today.getFullYear(), cm = today.getMonth() + 1;
  const { salt, hash } = L.hashSecret(DEMO_PASSWORD);
  tx(db, () => {
    db.prepare("UPDATE Settings SET Prefix = '01-', NextNo = 21, AdminHash = ?, AdminSalt = ?, SetupDone = 1, Lang = 'ku' WHERE ID = 1").run(hash, salt);
    for (const n of ['ئەحمەد', 'سارا']) db.prepare('INSERT INTO Users (Name) VALUES (?)').run(n);
    NAMES.forEach(([name, type], i) => {
      db.prepare('INSERT INTO Apartments (ApartmentNo, Floor, OwnerName, TenantName, Phone, Active) VALUES (?, ?, ?, ?, ?, 1)')
        .run(String(i + 1), String(Math.floor(i / 4) + 1), type === 'O' ? name : NAMES[(i + 7) % NAMES.length][0], type === 'T' ? name : null,
          `0750 ${String(1000000 + i * 7919).slice(1, 4)} ${String(1000 + i * 37).slice(-4)}`);
    });
  });

  // payments from January of last year up to this month; each apartment pays 1–3 months per receipt
  const plans = [];
  NAMES.forEach(([name, type], i) => {
    const apt = String(i + 1);
    const iqd = i % 5 === 3;                                 // some apartments pay in dinars
    const lazy = i % 7 === 5;                                // some skip months (unpaid in the reports)
    let y = cy - 1, m = 1;
    while (y < cy || (y === cy && m <= cm)) {
      const k = 1 + Math.floor(rand() * 3);
      const lines = [];
      for (let j = 0; j < k && (y < cy || (y === cy && m <= cm)); j++) {
        if (!(lazy && rand() < 0.45) && !(y === cy && m === cm && rand() < 0.5)) lines.push({ m, y, a: iqd ? 37500 : 25 });
        m++; if (m > 12) { m = 1; y++; }
      }
      if (!lines.length) continue;
      const first = lines[0];
      const day = 1 + Math.floor(rand() * 20);
      const d = new Date(first.y, first.m - 1, day);
      if (d > today) d.setTime(today.getTime());
      plans.push({ d, inp: { date: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`,
        name, type, apt, currency: iqd ? 'IQD' : 'USD', lines, receivedBy: rand() < 0.6 ? 'ئەحمەد' : 'سارا' } });
    }
  });
  // a walk-in payment without an apartment number
  plans.push({ d: new Date(cy, cm - 1, 1), inp: { date: `01/${String(cm).padStart(2, '0')}/${cy}`, name: 'میوان (بێ شوقە)', lines: [{ m: cm, y: cy, a: 15 }], receivedBy: 'ئەحمەد' } });
  plans.sort((a, b) => a.d - b.d);
  const made = plans.map((p) => L.createReceipt(db, p.inp, p.inp.receivedBy, true));

  // a couple of voided receipts and one edited receipt, so the list, VOID stamp and edit history have something to show
  for (const r of [made[5], made[Math.floor(made.length / 2)]]) L.voidReceipt(db, r.id, 'ئەحمەد');
  const e = made[made.length - 3];
  L.updateReceipt(db, e.id, { date: e.date, name: e.name, type: e.type, apt: e.apt, currency: e.currency, lines: e.lines,
    receivedBy: e.receivedBy, notes: 'دەستکاری کرا — نموونە', rev: e.rev }, 'سارا', true);
  return { receipts: made.length, apartments: NAMES.length };
}

module.exports = { seed, DEMO_PASSWORD };
