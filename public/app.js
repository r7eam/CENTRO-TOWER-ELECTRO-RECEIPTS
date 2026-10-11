/* CENTRO TOWER — browser UI (no frameworks, works offline) */
'use strict';

// ====================================================================== state
let TEXTS = {};
let LANG = 'ku';
let TODAY = '';                 // yyyy-mm-dd from the server
let USER = null;
let TOKEN = null;
let ADMIN = null;               // admin token (memory only — asks again after reload)
let RECEIPTS = [];              // list cache (newest first)
let APTS = [];                  // apartments cache
let CURRENT_VIEW = 'receipt';

const R = { mode: 'new', data: null, dirty: false, armVoid: false, busy: false, status: { key: 'new', err: false, params: {} }, autoName: false };
const A = { apt: '', year: null, data: null };      // apartment report
const M = { year: null, data: null };               // monthly summary
const S = { tab: 'book' };                          // settings

// localStorage can be unavailable (private mode) — never let it break the app
var store; // eslint-disable-line no-var
function storeImpl() {
  return {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
}

// ====================================================================== helpers
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function t(key, params) {
  const e = TEXTS[key];
  let s = e ? e[LANG === 'ar' ? 1 : 0] : key;
  // values without Arabic-script letters (receipt numbers, dates, file names) are isolated
  // left-to-right so "01-052" never shows as "052-01" inside a Kurdish/Arabic sentence
  const iso = (v) => (/[؀-ۿ]/.test(String(v)) ? String(v) : '⁦' + v + '⁩');
  if (params && params.m !== undefined && params.y !== undefined && params.my === undefined) params = { ...params, my: `${params.m}/${params.y}` };
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? iso(params[k]) : m));
  return s;
}
// one amount in its currency: $1,250  or  250,000 د.ع
function money(n, cur = 'USD') {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n).toLocaleString('en-US');
  // dinars are isolated right-to-left so they always read "80,000 د.ع" the Arabic way, in any surrounding text
  return cur === 'IQD' ? `⁧${v} ${t('symIQD')}⁩` : '$' + v;
}
// per-currency totals {USD, IQD} → "$1,250 + 375,000 د.ع" (never added together); empty → dash
function moneyObj(o, empty = '-') {
  if (!o) return empty;
  const parts = [];
  if (o.USD) parts.push(money(o.USD, 'USD'));
  if (o.IQD) parts.push(money(o.IQD, 'IQD'));
  return parts.length ? parts.join(' + ') : empty;
}
// same, as HTML with each currency on its own line (for narrow cells)
function moneyHtml(o, empty = '-') {
  if (!o || (!o.USD && !o.IQD)) return esc(empty);
  return [o.USD ? money(o.USD, 'USD') : null, o.IQD ? money(o.IQD, 'IQD') : null]
    .filter(Boolean).map((s) => `<span class="m2" dir="ltr">${esc(s)}</span>`).join('');
}
const curSym = (cur) => (cur === 'IQD' ? t('symIQD') : '$');
const pct = (x) => (x === null || x === undefined ? '-' : Math.round(x * 100) + '%');
function fmtDate(iso) { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}`; }
const monthName = (m) => t('m' + m);
const curYear = () => Number(TODAY.slice(0, 4));
const curMonth = () => Number(TODAY.slice(5, 7));
const typeText = (c) => (c === 'O' ? t('owner') : c === 'T' ? t('tenant') : '');
function normDigits(s) {
  return String(s ?? '').replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 0x0660).replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 0x06F0);
}
function aptCmp(a, b) {
  const na = /^\d+/.exec(a), nb = /^\d+/.exec(b);
  if (na && nb && +na[0] !== +nb[0]) return +na[0] - +nb[0];
  if (na && !nb) return -1;
  if (!na && nb) return 1;
  return a.localeCompare(b, 'en');
}
function errText(e) {
  if (!e) return t('errServer', { msg: '?' });
  if (e.error && TEXTS[e.error]) return t(e.error, e.params);
  return t('errServer', { msg: (e.params && e.params.msg) || e.error || e.message || String(e) });
}

async function api(method, url, body, opts = {}) {
  const headers = {};
  if (TOKEN) headers['X-Token'] = TOKEN;
  if (ADMIN) headers['X-Admin'] = ADMIN;
  let payload;
  if (body instanceof Blob) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, { method, headers, body: payload }); } catch { throw { error: 'errOffline' }; }
  if (opts.blob && res.ok) {
    const cd = res.headers.get('Content-Disposition') || '';
    const name = (/filename="([^"]+)"/.exec(cd) || [])[1] || 'download';
    return { blob: await res.blob(), name };
  }
  const data = await res.json().catch(() => ({ error: 'errServer', params: { msg: res.status + ' ' + res.statusText } }));
  if (!res.ok) {
    if (data.error === 'needLogin') { TOKEN = null; store.set('centroToken', null); showGate(); }
    if (data.error === 'needAdmin') ADMIN = null;
    throw data;
  }
  return data;
}
function download({ blob, name }) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ====================================================================== language
// online demo: a banner on every screen saying the data is fake (plus the demo admin password)
let DEMO_INFO = null;
function renderDemoBar() {
  const bar = document.getElementById('demoBar');
  if (!bar) return;
  bar.hidden = !DEMO_INFO;
  document.body.classList.toggle('demo', !!DEMO_INFO);
  if (DEMO_INFO) bar.textContent = t('demoBanner', { pw: DEMO_INFO.password });
}
function applyLang() {
  renderDemoBar();
  document.documentElement.lang = LANG === 'ar' ? 'ar' : 'ckb';
  document.title = t('formCaption');
  $$('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  $$('[data-t-ph]').forEach((el) => { el.placeholder = t(el.dataset.tPh); });
  $$('[data-t-title]').forEach((el) => { el.title = t(el.dataset.tTitle); });
}
async function toggleLang() {
  LANG = LANG === 'ar' ? 'ku' : 'ar';
  applyLang();
  relabelReceiptForm();
  updateTotal();
  setBackupWarning(BACKUP_WARNING);
  renderStatus();
  rerenderView();
  if (!$('#preview').hidden && PREVIEW_REC) renderPreview();
  if (!$('#gate').hidden) showGate();
  try { await api('POST', '/api/lang', { lang: LANG }); } catch { /* offline: keep local choice */ }
}

// ====================================================================== views
// Browser history: every screen change adds a history entry, so the browser / phone Back
// button returns to the previous screen (and first closes an open pop-up or print preview).
let FROM_HISTORY = false;
function show(view) {
  if (!FROM_HISTORY && view !== CURRENT_VIEW) history.pushState({ view }, '', '#' + view);
  CURRENT_VIEW = view;
  for (const v of ['receipt', 'list', 'apt', 'monthly', 'settings']) $('#view-' + v).hidden = v !== view;
  closeFind();
  window.scrollTo(0, 0);
}
function rerenderView() {
  if (CURRENT_VIEW === 'list') renderList();
  if (CURRENT_VIEW === 'apt') renderApt();
  if (CURRENT_VIEW === 'monthly') renderMonthly();
  if (CURRENT_VIEW === 'settings') renderSettings();
  if (!$('#modal').hidden && MODAL_RERENDER) MODAL_RERENDER();
}
const backBar = (titleHtml, extra = '') =>
  `<div class="page-h"><button class="btn btn-white" data-act="back">→ ${esc(t('btnBack'))}</button><h2>${titleHtml}</h2><span class="grow"></span>${extra}</div>`;

// ====================================================================== gate: setup + login
let GATE_INFO = null;
async function showGate() {
  $('#app').hidden = true;
  const g = $('#gate');
  g.hidden = false;
  try { GATE_INFO = await api('GET', '/api/bootstrap'); } catch (e) { g.innerHTML = `<div class="gate-box"><div class="gate-body"><div class="err">${esc(errText(e))}</div></div></div>`; return; }
  TEXTS = GATE_INFO.texts; TODAY = GATE_INFO.today; DEMO_INFO = GATE_INFO.demo; renderDemoBar();
  const head = `<div class="gate-head"><div><div class="brand-name">CENTRO TOWER</div><div class="muted">${esc(t('subtitle'))}</div></div>
    <button class="btn btn-gold btn-sm" id="gLang">${esc(t('langToggle'))}</button></div>`;
  if (!GATE_INFO.setupDone) {
    g.innerHTML = `<form class="gate-box" id="gForm" autocomplete="off">${head}<div class="gate-body">
      <h3 style="margin:0;color:var(--navy)">${esc(t('setupTitle'))}</h3><div class="muted">${esc(t('setupIntro'))}</div>
      <div class="field"><label>${esc(t('lblFirstUser'))}</label><input id="gUser" maxlength="60" required></div>
      <div class="field-row">
        <div class="field"><label>${esc(t('lblPrefix'))}</label><input id="gPrefix" value="01-" maxlength="10" dir="ltr"></div>
        <div class="field"><label>${esc(t('lblStartNo'))}</label><input id="gStart" value="1" inputmode="numeric" dir="ltr"></div>
      </div>
      <div class="muted" id="gEx"></div>
      <div class="field"><label>${esc(t('lblAdminPw'))}</label><input id="gPw" type="password" autocomplete="new-password"></div>
      <div class="field"><label>${esc(t('lblAdminPw2'))}</label><input id="gPw2" type="password" autocomplete="new-password"></div>
      <div class="err" id="gErr"></div>
      <button class="btn btn-gold" type="submit">${esc(t('btnStart'))}</button></div></form>`;
    const ex = () => {
      const n = parseInt(normDigits($('#gStart').value), 10) || 1;
      $('#gEx').textContent = t('startNoHint', { ex: ($('#gPrefix').value || '01-') + String(n).padStart(3, '0') });
    };
    $('#gStart').oninput = ex; $('#gPrefix').oninput = ex; ex();
    $('#gForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const err = $('#gErr');
      if ($('#gPw').value !== $('#gPw2').value) { err.textContent = t('pwMismatch'); return; }
      try {
        const r = await api('POST', '/api/setup', { userName: $('#gUser').value, prefix: $('#gPrefix').value, startNo: $('#gStart').value, adminPassword: $('#gPw').value, lang: LANG });
        loggedIn(r);
      } catch (e) { err.textContent = errText(e); }
    };
  } else {
    let pick = GATE_INFO.users.length === 1 ? GATE_INFO.users[0] : null;
    const render = () => {
      g.innerHTML = `<form class="gate-box" id="gForm">${head}<div class="gate-body">
        <h3 style="margin:0;color:var(--navy)">${esc(t('loginTitle'))}</h3>
        <div class="user-pick">${GATE_INFO.users.map((u, i) => `<button type="button" class="btn ${pick && pick.name === u.name ? 'on' : ''}" data-i="${i}">${esc(u.name)}</button>`).join('')}</div>
        ${pick && pick.hasPin ? `<div class="field"><label>${esc(t('lblPin'))}</label><input id="gPin" type="password" inputmode="numeric" autocomplete="off" dir="ltr"></div>` : ''}
        <div class="err" id="gErr"></div>
        <button class="btn btn-gold" type="submit" ${pick ? '' : 'disabled'}>${esc(t('btnLogin'))}</button></div></form>`;
      $$('.user-pick .btn', g).forEach((b) => { b.onclick = () => { pick = GATE_INFO.users[+b.dataset.i]; render(); }; });
      if ($('#gPin')) $('#gPin').focus();
      $('#gLang').onclick = toggleLang;
      $('#gForm').onsubmit = async (ev) => {
        ev.preventDefault();
        if (!pick) return;
        try { loggedIn(await api('POST', '/api/login', { name: pick.name, pin: $('#gPin') ? $('#gPin').value : '' })); }
        catch (e) { $('#gErr').textContent = errText(e); }
      };
    };
    render();
    return;
  }
  $('#gLang').onclick = toggleLang;
}
function loggedIn(r) {
  TOKEN = r.token; store.set('centroToken', TOKEN);
  USER = r.user;
  startApp();
}

// ====================================================================== boot
async function boot() {
  store = storeImpl();
  TOKEN = store.get('centroToken');
  let b;
  try { b = await api('GET', '/api/bootstrap'); } catch (e) { document.body.innerHTML = `<div class="empty">${esc(errText(e))}</div>`; return; }
  TEXTS = b.texts; LANG = b.lang; TODAY = b.today; DEMO_INFO = b.demo;
  applyLang();
  if (!b.setupDone || !b.user) return showGate();
  USER = b.user;
  startApp();
}
let WIRED = false;
async function startApp() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
  try { const b = await api('GET', '/api/bootstrap'); TEXTS = b.texts; LANG = b.lang; TODAY = b.today; setBackupWarning(b.backupWarning); } catch { /* keep */ }
  $('#userName').textContent = USER ? USER.name : '';
  applyLang();
  if (!WIRED) { buildReceiptForm(); wire(); WIRED = true; } else { relabelReceiptForm(); }
  await Promise.all([refreshReceipts(), refreshApts()]);
  newReceipt();
  FROM_HISTORY = true; show('receipt'); FROM_HISTORY = false;
  history.replaceState({ view: 'receipt' }, '', '#receipt');
}
// an overlay (print preview, month pop-up) gets its own history entry, so Back closes it
function pushOverlay(kind) { history.pushState({ view: CURRENT_VIEW, overlay: kind }, '', location.hash); }
function closeOverlay(hide) {
  if (history.state && history.state.overlay) history.back();   // popstate does the hiding
  else hide();
}
window.addEventListener('popstate', (e) => {
  const st = e.state || { view: 'receipt' };
  if (!$('#preview').hidden) $('#preview').hidden = true;
  if (!$('#modal').hidden) closeModal();
  if (st.overlay) { history.back(); return; }                      // never land on a stale overlay entry
  if (st.view === CURRENT_VIEW) return;
  FROM_HISTORY = true;
  try {
    if (st.view === 'list') openList();
    else if (st.view === 'apt') openAptReport(A.apt, A.year);
    else if (st.view === 'monthly') openMonthly();
    else if (st.view === 'settings' && ADMIN) { show('settings'); renderSettings(); }
    else show('receipt');
  } finally { FROM_HISTORY = false; }
});

// ====================================================================== receipt form
function yearOptions(extra = []) {
  const cy = curYear();
  const ys = new Set();
  for (let y = cy - 3; y <= cy + 1; y++) ys.add(y);
  for (const y of extra) if (y) ys.add(Number(y));
  return [...ys].sort((a, b) => a - b);
}
function buildReceiptForm() {
  const body = $('#linesBody');
  body.innerHTML = [1, 2, 3].map((i) => `<tr>
      <td class="num-col">${i}</td>
      <td><select class="ed" id="fM${i}"></select></td>
      <td><select class="ed" id="fY${i}"></select></td>
      <td><input class="ed" id="fA${i}" inputmode="numeric" dir="ltr" maxlength="9" autocomplete="off"></td></tr>`).join('');
  relabelReceiptForm();
  fillYearSelects([]);
}
function relabelReceiptForm() {
  const tsel = $('#fType');
  if (tsel) {
    const v = tsel.value;
    tsel.innerHTML = `<option value=""></option><option value="O">${esc(t('owner'))}</option><option value="T">${esc(t('tenant'))}</option>`;
    tsel.value = v;
  }
  const csel = $('#fCur');
  if (csel) {
    const v = csel.value || 'USD';
    csel.innerHTML = `<option value="USD">${esc(t('curUSD'))}</option><option value="IQD">${esc(t('curIQD'))}</option>`;
    csel.value = v;
  }
  for (let i = 1; i <= 3; i++) {
    const s = $('#fM' + i);
    if (!s) continue;
    const v = s.value;
    s.innerHTML = '<option value=""></option>' + Array.from({ length: 12 }, (_, k) => `<option value="${k + 1}">${esc(monthName(k + 1))}</option>`).join('');
    s.value = v;
  }
}
function fillYearSelects(extra) {
  const ys = yearOptions(extra);
  for (let i = 1; i <= 3; i++) {
    const s = $('#fY' + i);
    const v = s.value;
    s.innerHTML = '<option value=""></option>' + ys.map((y) => `<option value="${y}">${y}</option>`).join('');
    s.value = v;
  }
}
function fillForm(rec) {
  const lines = rec ? rec.lines : [{}, {}, {}];
  fillYearSelects(lines.map((l) => l.y));
  $('#fDate').value = fmtDate(rec ? rec.date : TODAY);
  $('#fName').value = rec ? rec.name || '' : '';
  $('#fType').value = rec ? rec.type || '' : '';
  $('#fApt').value = rec ? rec.apt || '' : '';
  $('#fCur').value = rec ? rec.currency || 'USD' : 'USD';
  $('#fRecv').value = rec ? rec.receivedBy || '' : (USER ? USER.name : '');
  $('#fNotes').value = rec ? rec.notes || '' : '';
  for (let i = 1; i <= 3; i++) {
    const l = lines[i - 1] || {};
    $('#fM' + i).value = l.m ? String(l.m) : '';
    $('#fY' + i).value = l.y ? String(l.y) : '';
    $('#fA' + i).value = l.a ? String(l.a) : '';
  }
  R.autoName = false;
  updateTotal();
}
function collect() {
  return {
    date: normDigits($('#fDate').value),
    name: $('#fName').value, type: $('#fType').value, apt: $('#fApt').value, currency: $('#fCur').value,
    receivedBy: $('#fRecv').value, notes: $('#fNotes').value,
    lines: [1, 2, 3].map((i) => ({ m: $('#fM' + i).value, y: $('#fY' + i).value, a: normDigits($('#fA' + i).value) })),
    rev: R.data ? R.data.rev : undefined,
  };
}
function isBlank() {
  const c = collect();
  return !c.name.trim() && !c.apt.trim() && !c.type && !c.notes.trim() && c.lines.every((l) => !l.m && !l.y && !String(l.a).trim());
}
function updateTotal() {
  let s = 0;
  for (let i = 1; i <= 3; i++) { const v = parseInt(normDigits($('#fA' + i).value).replace(/[$,\s]/g, ''), 10); if (v > 0) s += v; }
  const cur = $('#fCur').value || 'USD';
  $('#totalVal').textContent = money(s, cur);
  $('#thAmount').textContent = `${t('colAmount')} (${curSym(cur)})`;
}
function setLocked(b) {
  $$('#view-receipt .ed').forEach((el) => { el.disabled = b; });
}
function updateReceiptUI() {
  $('#rNo').textContent = R.data ? R.data.no : '';
  $('#rAuto').hidden = R.mode !== 'new';
  $('#voidBadge').hidden = !(R.data && R.data.cancelled);
  setLocked(R.mode === 'locked' || R.mode === 'void');
}
function setStatus(key, err = false, params = {}) { R.status = { key, err, params }; renderStatus(); }
function renderStatus() {
  const el = $('#status');
  if (!el) return;
  el.textContent = R.status.raw ? R.status.raw() : t(R.status.key, R.status.params);
  el.classList.toggle('err', !!R.status.err);
}
function setStatusErr(e) {
  if (e && e.error) R.status = { key: e.error, err: true, params: e.params || {}, raw: () => errText(e) };
  else R.status = { key: 'errServer', err: true, params: {}, raw: () => errText(e) };
  renderStatus();
}

function newReceipt() {
  R.mode = 'new'; R.data = null; R.dirty = false; R.armVoid = false;
  fillForm(null);
  updateReceiptUI();
  setStatus('new');
}
function loadReceipt(rec) {
  R.data = rec; R.mode = rec.cancelled ? 'void' : 'locked'; R.dirty = false; R.armVoid = false;
  fillForm(rec);
  updateReceiptUI();
}

// save the current receipt (new or editing). Returns true when saved.
async function save(confirmDup = false) {
  if (R.busy) return false;
  R.busy = true; setBusy(true);
  const body = { receipt: collect(), confirmDup };
  try {
    const rec = R.mode === 'new' ? await api('POST', '/api/receipts', body) : await api('PUT', `/api/receipts/${R.data.id}`, body);
    loadReceipt(rec);
    setStatus('saved');
    refreshReceipts(); refreshApts();
    return true;
  } catch (e) {
    if (e.error === 'dupOther') {
      R.busy = false; setBusy(false);
      if (await confirmDups(e)) return save(true);
      const items = (e.dups || []).map((d) => t('dupItem', d)).join('، ');
      R.status = { key: 'dupOther', err: true, params: e.params, raw: () => `${t('dupOther', e.params)} ${items}` };
      renderStatus();
      return false;
    }
    setStatusErr(e);
    return false;
  } finally { R.busy = false; setBusy(false); }
}
function setBusy(b) { $$('.actions .btn').forEach((x) => { x.disabled = b; }); }

// leaving the receipt (search, New, Print, open another): save first if there are unsaved changes
async function leaveReceipt() {
  if (R.mode === 'new' && !isBlank()) return save();
  if (R.mode === 'editing' && R.dirty) return save();
  if (R.mode === 'editing') { loadReceipt(R.data); }
  return true;
}
async function openReceipt(id) {
  R.armVoid = false;
  if (!(await leaveReceipt())) { closeModal(); show('receipt'); return; }
  try {
    const rec = await api('GET', `/api/receipts/${id}`);
    loadReceipt(rec);
    setStatus(rec.cancelled ? 'isVoid' : 'locked', rec.cancelled);
    closeModal();
    show('receipt');
  } catch (e) { setStatusErr(e); }
}

function confirmDups(e) {
  return new Promise((resolve) => {
    const items = (e.dups || []).map((d) => `<li>${esc(t('dupItem', { m: d.m, y: d.y, no: d.no }))}</li>`).join('');
    openModal(`<div class="modal-head"><h3>⚠ ${esc(t('dupOtherTitle'))}</h3></div>
      <div class="modal-body"><div><b>${esc(t('dupOther', e.params))}</b></div><ul style="margin:0">${items}</ul></div>
      <div class="modal-foot"><button class="btn btn-white" id="dNo">${esc(t('cancel'))}</button><button class="btn btn-danger" id="dYes">${esc(t('dupConfirm'))}</button></div>`, { small: true });
    $('#dYes').onclick = () => { closeModal(); resolve(true); };
    $('#dNo').onclick = () => { closeModal(); resolve(false); };
    MODAL_ON_CLOSE = () => resolve(false);
  });
}

// ----- receipt buttons
async function onNew() { R.armVoid = false; if (await leaveReceipt()) { newReceipt(); $('#fName').focus(); } }
async function onSave() {
  R.armVoid = false;
  if (R.mode === 'void') return setStatus('isVoid', true);
  if (R.mode === 'locked') return setStatus('locked');
  await save();
}
function onEdit() {
  R.armVoid = false;
  if (R.mode === 'new' || R.mode === 'editing') return;
  if (R.mode === 'void') return setStatus('isVoid', true);
  R.mode = 'editing'; R.dirty = false;
  updateReceiptUI();
  setStatus('editing');
  $('#fName').focus();
}
async function onPrint() {
  R.armVoid = false;
  if (R.mode === 'new' && isBlank()) return setStatus('saveFirst', true);
  if (!(await leaveReceipt())) return;
  if (!R.data) return setStatus('saveFirst', true);
  openPreview(R.data);
}
async function onVoid() {
  if (R.mode === 'new') { newReceipt(); return; }
  if (R.data.cancelled) return setStatus('isVoid', true);
  if (!R.armVoid) { R.armVoid = true; setStatus('voidAsk', true); return; }
  R.armVoid = false;
  try {
    const rec = await api('POST', `/api/receipts/${R.data.id}/void`);
    loadReceipt(rec);
    setStatus('voided', true);
    refreshReceipts();
  } catch (e) { setStatusErr(e); }
}

// apartment autocomplete → fill name/type
function onAptChange() {
  const v = normDigits($('#fApt').value).trim().toUpperCase();
  const a = APTS.find((x) => x.apt.toUpperCase() === v);
  if (!a) return;
  if (!$('#fName').value.trim() || R.autoName) {
    if (a.name) { $('#fName').value = a.name; R.autoName = true; }
    if (a.type && (!$('#fType').value || R.autoName)) $('#fType').value = a.type;
  }
}
async function refreshApts() {
  try { APTS = await api('GET', '/api/apartments'); } catch { return; }
  $('#aptList').innerHTML = APTS.filter((a) => a.active).map((a) => `<option value="${esc(a.apt)}">${esc(a.name || '')}</option>`).join('');
}
async function refreshReceipts() {
  try { RECEIPTS = await api('GET', '/api/receipts'); } catch { return; }
  if (!$('#findList').hidden) renderFind();
  if (CURRENT_VIEW === 'list') renderListBody();
}

// ====================================================================== header search
let FIND_SEL = -1;
function filterReceipts(q) {
  q = normDigits(q).trim().toLowerCase();
  if (!q) return RECEIPTS;
  return RECEIPTS.filter((r) => [r.no, r.name, r.apt].some((v) => String(v || '').toLowerCase().includes(q)));
}
function renderFind() {
  const list = filterReceipts($('#find').value).slice(0, 200);
  FIND_SEL = Math.min(FIND_SEL, list.length - 1);
  $('#findList').innerHTML = `<div class="dd-row dd-head"><span>${esc(t('lblReceiptNo'))}</span><span>${esc(t('lblName'))}</span><span>${esc(t('lblApt'))}</span></div>` +
    (list.length ? list.map((r, i) => `<div class="dd-row ${r.cancelled ? 'void' : ''} ${i === FIND_SEL ? 'on' : ''}" data-id="${r.id}">
      <span class="dd-no">${esc(r.no)}</span><span>${esc(r.name || '')}</span><span>${esc(r.apt || '')}</span></div>`).join('')
      : `<div class="empty">${esc(t('listEmpty'))}</div>`);
  $('#findList').hidden = false;
}
function closeFind() { $('#findList').hidden = true; FIND_SEL = -1; }

// ====================================================================== Screen 2: receipts list
function renderList() {
  const v = $('#view-list');
  v.innerHTML = backBar(esc(t('listTitle')), `<div class="inline"><label for="lFind">${esc(t('search'))}</label><input id="lFind" type="search" autocomplete="off" value="${esc(v.dataset.q || '')}"></div>`) +
    `<div class="table-wrap"><table class="data"><thead><tr>
      <th>${esc(t('colNo'))}</th><th>${esc(t('colDate'))}</th><th>${esc(t('colName'))}</th><th>${esc(t('colType'))}</th>
      <th>${esc(t('colApt'))}</th><th>${esc(t('colTotal'))}</th><th>${esc(t('colStatus'))}</th></tr></thead><tbody id="lBody"></tbody></table></div>`;
  $('#lFind').oninput = () => { v.dataset.q = $('#lFind').value; renderListBody(); };
  renderListBody();
}
function renderListBody() {
  const body = $('#lBody');
  if (!body) return;
  const list = filterReceipts($('#lFind').value);
  body.innerHTML = list.length ? list.map((r) => `<tr>
      <td class="no dbl" data-open="${r.id}">${esc(r.no)}</td>
      <td class="dbl" data-open="${r.id}" dir="ltr">${esc(fmtDate(r.date))}</td>
      <td class="start dbl" data-open="${r.id}">${esc(r.name || '')}</td>
      <td>${esc(typeText(r.type))}</td>
      <td class="dbl" data-apt="${esc(r.apt || '')}">${esc(r.apt || '')}</td>
      <td dir="ltr"><b>${esc(money(r.total, r.cur))}</b></td>
      <td>${r.cancelled ? `<span class="st-void">${esc(t('void'))}</span>` : ''}</td></tr>`).join('')
    : `<tr><td colspan="7" class="empty">${esc(t('listEmpty'))}</td></tr>`;
}
async function openList() { show('list'); renderList(); await refreshReceipts(); }

// ====================================================================== Screen 3: apartment report
async function openAptReport(apt, year) {
  A.apt = apt || ''; A.year = year || null; A.data = null;
  show('apt');
  await refreshApts();
  await loadApt();
}
async function loadApt() {
  A.data = null;
  if (A.apt) {
    try { A.data = await api('GET', `/api/reports/apartment?apt=${encodeURIComponent(A.apt)}${A.year ? '&year=' + A.year : ''}`); A.year = A.data.year; }
    catch (e) { A.data = null; A.err = errText(e); }
  }
  renderApt();
}
function aptGridHtml(d) {
  return `<div class="mgrid">${d.grid.map((g) => `<div class="mcell ${g.state}"><div class="mh">${g.m}</div>
    <div class="mv">${g.state === 'paid' ? moneyHtml(g.amount) : g.state === 'unpaid' ? '✗' : ''}</div></div>`).join('')}</div>`;
}
function aptLinesHtml(d, interactive) {
  return `<table class="data"><thead><tr><th>${esc(t('colMonth'))}</th><th>${esc(t('colAmount'))}</th><th>${esc(t('colReceiptNo'))}</th></tr></thead>
    <tbody>${d.lines.length ? d.lines.map((l) => `<tr><td>${esc(monthName(l.m))}</td><td dir="ltr"><b>${esc(money(l.a, l.c))}</b></td>
      <td class="no ${interactive ? 'dbl' : ''}" ${interactive ? `data-open="${l.id}"` : ''}>${esc(l.no)}</td></tr>`).join('')
      : `<tr><td colspan="3" class="empty">${esc(t('kNoData'))}</td></tr>`}</tbody></table>`;
}
function renderApt() {
  const v = $('#view-apt');
  const opts = APTS.map((a) => `<option value="${esc(a.apt)}" ${a.apt.toUpperCase() === A.apt.toUpperCase() ? 'selected' : ''}>${esc(a.apt)}${a.name ? ' - ' + esc(a.name) : ''}</option>`).join('');
  const d = A.data;
  const years = d ? d.years : [];
  v.innerHTML = backBar(esc(t('aptCaption')),
    `<div class="inline"><label for="aSel">${esc(t('lblAptSel'))}</label><select id="aSel"><option value="">${esc(t('noApt'))}</option>${opts}</select></div>
     <div class="inline"><label for="aYear">${esc(t('lblYearSel'))}</label><select id="aYear" ${d ? '' : 'disabled'}>${years.map((y) => `<option ${y === A.year ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
     <button class="btn btn-navy" id="aPrint" ${d ? '' : 'disabled'}>${esc(t('btnPrint'))}</button>`) +
    (d ? `<div class="info-line">${esc(t('aptCaption'))} ${esc(d.apt)}${d.name ? ' - ' + esc(d.name) : ''}</div>
      ${aptGridHtml(d)}
      <div class="year-total"><span>${esc(t('yearTotalLbl'))}</span><span class="v" dir="ltr">${esc(moneyObj(d.total, money(0)))}</span></div>
      <div class="table-wrap">${aptLinesHtml(d, true)}</div>`
      : `<div class="card empty">${esc(A.err || t('noApt'))}</div>`);
  A.err = null;
  $('#aSel').onchange = () => { A.apt = $('#aSel').value; A.year = null; loadApt(); };
  $('#aYear').onchange = () => { A.year = Number($('#aYear').value); loadApt(); };
  $('#aPrint').onclick = () => d && printReport(aptReportHtml(d));
}
function aptReportHtml(d) {
  return `<div class="rp"><div class="rp-head"><span class="t">CENTRO TOWER</span><span class="c">${esc(t('aptCaption'))}</span></div>
    <div class="rp-meta"><span class="i">${esc(t('aptCaption'))} ${esc(d.apt)}${d.name ? ' - ' + esc(d.name) : ''} · ${d.year}</span>
      <span>${esc(t('printedOn'))}: <span dir="ltr">${esc(fmtDate(TODAY))}</span></span></div>
    ${aptGridHtml(d)}
    <div class="year-total"><span>${esc(t('yearTotalLbl'))}</span><span class="v" dir="ltr">${esc(moneyObj(d.total, money(0)))}</span></div>
    ${aptLinesHtml(d, false)}</div>`;
}

// ====================================================================== Screen 4: monthly summary
async function openMonthly() {
  show('monthly');
  M.year = M.year || curYear();
  await loadMonthly();
}
async function loadMonthly() {
  try { M.data = await api('GET', `/api/reports/monthly?year=${M.year}`); M.err = null; }
  catch (e) { M.data = null; M.err = errText(e); }
  renderMonthly();
}
function kpiHtml(d) {
  const k = d.kpi;
  // previous-year line: each currency with its own % change
  const prevParts = ['USD', 'IQD'].filter((c) => k.prevTotal[c]).map((c) => {
    const p = k.prevPct[c];
    const ch = p === null ? '' : ` (<span class="${p >= 0 ? 'up' : 'down'}" dir="ltr">${p >= 0 ? '+' : ''}${Math.round(p * 100)}%</span>)`;
    return `<span dir="ltr">${esc(money(k.prevTotal[c], c))}</span>${ch}`;
  });
  return `<div class="kpis">
    <div class="kpi"><div class="k">${esc(t('kTotal'))}</div><div class="v">${moneyHtml(k.total, money(0))}</div>
      <div class="s">${esc(t('kPrev'))}: ${prevParts.length ? prevParts.join(' + ') : '-'}</div></div>
    <div class="kpi"><div class="k">${esc(t('kAvg'))}</div><div class="v">${moneyHtml(k.avg, money(0))}</div>
      <div class="s">${k.monthsPaid} ${esc(t('kMonths'))}</div></div>
    <div class="kpi"><div class="k">${esc(t('kApts'))}</div><div class="v" dir="ltr">${k.paying} / ${k.allApts}</div>
      <div class="s">${esc(t('kOfApts'))} (<span dir="ltr">${pct(k.payingPct)}</span>)</div></div>
    <div class="kpi"><div class="k">${esc(t('kBest'))}</div><div class="v">${k.bestMonth ? esc(monthName(k.bestMonth)) : '-'}</div>
      <div class="s">${k.bestMonth ? `<span dir="ltr">${esc(moneyObj(k.bestAmount))}</span>` : esc(t('kNoData'))}</div></div></div>`;
}
function monthlyTableHtml(d, interactive) {
  const isCur = d.year === d.currentYear;
  return `<table class="data"><thead><tr><th>${esc(t('colMonth'))}</th><th>${esc(t('colAmount'))}</th><th>${esc(t('colApts'))}</th>
      <th>${esc(t('colRate'))}</th><th>${esc(t('colPayments'))}</th><th>${esc(t('colPrev'))}</th>${interactive ? '<th></th>' : ''}</tr></thead>
    <tbody>${d.rows.map((r) => `<tr class="${interactive ? 'clickable' : ''} ${isCur && r.m === d.currentMonth ? 'cur' : ''}" ${interactive ? `data-month="${r.m}"` : ''}>
      <td class="start">${esc(monthName(r.m))}</td><td><b>${moneyHtml(r.amount)}</b></td><td>${r.apts}</td>
      <td>${r.payments ? pct(r.rate) : '-'}</td><td>${r.payments}</td><td>${moneyHtml(r.prev)}</td>
      ${interactive ? `<td class="bar">${'█'.repeat(r.bar)}</td>` : ''}</tr>`).join('')}</tbody>
    <tfoot><tr><td>${esc(t('rowTotal'))}</td><td>${moneyHtml(d.totals.amount)}</td><td></td><td></td><td>${d.totals.payments}</td>
      <td>${moneyHtml(d.totals.prev)}</td>${interactive ? '<td></td>' : ''}</tr></tfoot></table>`;
}
function monthlyReportHtml(d) {
  return `<div class="rp"><div class="rp-head"><span class="t">CENTRO TOWER</span>
      <span class="c">${esc(t('monthlyCaption'))} - ${d.year}</span></div>
      <div class="rp-meta"><span class="i">${esc(t('monthlyCaption'))} - ${d.year}</span><span>${esc(t('printedOn'))}: <span dir="ltr">${esc(fmtDate(TODAY))}</span></span></div>
      ${kpiHtml(d)}${monthlyTableHtml(d, false)}</div>`;
}
function renderMonthly() {
  const v = $('#view-monthly');
  const d = M.data;
  v.innerHTML = backBar(esc(t('monthlyCaption')),
    `<div class="inline"><label for="mYear">${esc(t('lblYearSel'))}</label><select id="mYear">${(d ? d.years : [M.year]).map((y) => `<option ${y === M.year ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
     <button class="btn btn-navy" id="mPrint" ${d ? '' : 'disabled'}>${esc(t('btnPrint'))}</button>`) +
    (d ? `${kpiHtml(d)}<div class="table-wrap">${monthlyTableHtml(d, true)}</div><div class="hint">${esc(t('hintClick'))}</div>`
      : `<div class="card empty">${esc(M.err || '')}</div>`);
  $('#mYear').onchange = () => { M.year = Number($('#mYear').value); loadMonthly(); };
  $('#mPrint').onclick = () => d && printReport(monthlyReportHtml(d));
  $$('#view-monthly tr[data-month]').forEach((tr) => { tr.onclick = () => openMonthApts(d.year, Number(tr.dataset.month)); });
}

// ====================================================================== Screen 5: apartments of a month (pop-up)
async function openMonthApts(year, month) {
  let d;
  try { d = await api('GET', `/api/reports/month?year=${year}&month=${month}`); } catch (e) { alert(errText(e)); return; }
  const render = () => {
    const rows = d.rows.map((r) => `<tr>
        <td class="no dbl" data-apt="${esc(r.apt)}">${esc(r.apt)}</td><td class="start">${esc(r.name || '')}</td>
        <td>${r.paid ? `<span class="st-paid">${esc(t('stPaid'))}</span>` : `<span class="st-unpaid">${esc(t('stUnpaid'))}</span>`}</td>
        <td><b>${r.paid ? moneyHtml(r.amount, '') : ''}</b></td>
        <td>${r.no ? `<button class="linkish" data-open="${r.id}">${esc(r.no)}</button>` : ''}</td></tr>`);
    if (d.noApt) {
      const at = d.rows.filter((r) => r.paid).length;
      rows.splice(at, 0, `<tr><td class="muted">—</td><td class="start muted">${esc(t('noAptRow'))}</td><td><span class="st-paid">${esc(t('stPaid'))}</span></td>
        <td><b>${moneyHtml(d.noApt.amount)}</b></td><td>${d.noApt.no ? `<button class="linkish" data-open="${d.noApt.id}">${esc(d.noApt.no)}</button>` : ''}</td></tr>`);
    }
    openModal(`<div class="modal-head"><h3>${esc(t('monthApts'))}: ${esc(monthName(month))} ${year}</h3><button class="chip-btn" data-close>✕</button></div>
      <div class="modal-body">
        <div class="info-line" style="font-size:15px"><span class="st-paid">${esc(t('stPaid'))}: ${d.paidCount}</span> | <span class="st-unpaid">${esc(t('stUnpaid'))}: ${d.unpaidCount}</span>
          <span class="muted" style="margin-inline-start:12px" dir="ltr">${esc(moneyObj(d.total, ''))}</span></div>
        <div class="table-wrap"><table class="data"><thead><tr><th>${esc(t('colApt'))}</th><th>${esc(t('colName'))}</th><th>${esc(t('colStatus'))}</th>
          <th>${esc(t('colAmount'))}</th><th>${esc(t('colReceiptNo'))}</th></tr></thead>
          <tbody>${rows.join('') || `<tr><td colspan="5" class="empty">${esc(t('kNoData'))}</td></tr>`}</tbody></table></div>
      </div>`, { rerender: render });
  };
  render();
  pushOverlay('month');
}
// close the pop-up the way the user asked (✕, backdrop, Esc): through history when it has an entry
function closeModalUI() {
  if (history.state && history.state.overlay === 'month') history.back(); else closeModal();
}
const closePreviewUI = () => closeOverlay(() => { $('#preview').hidden = true; });

// ====================================================================== modal
let MODAL_ON_CLOSE = null, MODAL_RERENDER = null;
function openModal(html, opts = {}) {
  const m = $('#modal');
  m.classList.toggle('small', !!opts.small);
  $('.modal-box', m).innerHTML = html;
  m.hidden = false;
  MODAL_RERENDER = opts.rerender || null;
  const btn = $('.modal-box button', m); if (btn && opts.small) btn.focus();
}
function closeModal() {
  const m = $('#modal');
  if (m.hidden) return;
  m.hidden = true; $('.modal-box', m).innerHTML = '';
  MODAL_RERENDER = null;
  const cb = MODAL_ON_CLOSE; MODAL_ON_CLOSE = null; if (cb) cb();
}
// asks for a value; check(value) returns an error text (stay open) or null (done)
function promptModal(title, label, check) {
  return new Promise((resolve) => {
    openModal(`<form id="pmForm"><div class="modal-head"><h3>${esc(title)}</h3></div>
      <div class="modal-body"><div class="field"><label>${esc(label)}</label><input id="pmVal" type="password" autocomplete="off"></div><div class="err-msg" id="pmErr"></div></div>
      <div class="modal-foot"><button type="button" class="btn btn-white" id="pmNo">${esc(t('cancel'))}</button><button class="btn btn-gold" type="submit">${esc(t('btnOpen'))}</button></div></form>`, { small: true });
    $('#pmVal').focus();
    MODAL_ON_CLOSE = () => resolve(false);
    $('#pmNo').onclick = () => closeModal();
    $('#pmForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const err = await check($('#pmVal').value);
      if (err) { $('#pmErr').textContent = err; $('#pmVal').select(); return; }
      MODAL_ON_CLOSE = null; closeModal(); resolve(true);
    };
  });
}

// ====================================================================== printing
let PREVIEW_REC = null;
const paperKey = 'centroPaper';
function setPageCss(kind) {
  const paper = $('#paperSel').value;
  $('#pageStyle').textContent = kind === 'receipt'
    ? (paper === 'A4' ? '@page { size: A4 portrait; margin: 1cm; }' : '@page { size: A5 landscape; margin: 1cm 1.05cm; }')
    : `@page { size: A4 portrait; margin: 1.2cm 1.2cm 1.6cm; @bottom-center { content: "CENTRO TOWER   " counter(page) " / " counter(pages); font: 9pt Tahoma, sans-serif; color: #646C7A; } }`;
}
function receiptSheetHtml(r) {
  const sym = curSym(r.currency);
  const opt = (code, key) => `<span class="rc-opt"><span class="rc-cb ${r.type === code ? 'on' : ''}"></span>${esc(t(key))}</span>`;
  const [yy, mm, dd] = (r.date || '').split('-');
  const boxes = [1, 2, 3].map((i) => {
    const l = r.lines[i - 1] || {};
    return `<div class="rc-box"><div class="rc-box-h"><span class="rc-lbl">${esc(t('prMY'))}</span><span class="rc-idx">0${i}</span></div>
      <div class="rc-my ${l.m ? '' : 'is-empty'}">${l.m ? `${l.m} / ${l.y || ''}` : '—'}</div>
      <div class="rc-amt"><span class="rc-dollar">${esc(sym)}</span><span class="rc-dots">${l.a ? Number(l.a).toLocaleString('en-US') : ''}</span></div></div>`;
  }).join('');
  const months = r.lines.filter((l) => l.m).map((l) => `${l.m}/${l.y || ''}`).join(' + ');
  const tot = Number(r.total || 0).toLocaleString('en-US');
  return `<div class="rc">
    <div class="rc-main">
      <div class="rc-head"><div><div class="rc-title">CENTRO TOWER</div><div class="rc-sub">${esc(t('printSub'))}</div></div>
        <div class="rc-no" dir="ltr">No. ${esc(r.no)}</div></div>
      <div class="rc-goldbar"></div>
      <div class="rc-row rc-row1"><span class="rc-lbl">${esc(t('prDear'))}</span><span class="rc-line rc-name">${esc(r.name || '')}</span>
        <span class="rc-type"><span class="rc-lbl">${esc(t('typeLbl'))}:</span>${opt('O', 'owner')}${opt('T', 'tenant')}</span></div>
      <div class="rc-row rc-row2"><span class="rc-lbl">${esc(t('prApt'))}</span><span class="rc-line rc-apt">${esc(r.apt || '')}</span><span class="rc-gap"></span>
        <span class="rc-lbl">${esc(t('prDate'))}</span>
        <span class="rc-date"><span class="seg">${esc(dd || '')}</span>/<span class="seg">${esc(mm || '')}</span>/<span class="seg y">${esc(yy || '')}</span></span></div>
      <div class="rc-boxes">${boxes}${r.cancelled ? `<div class="rc-stamp">${esc(t('void'))}</div>` : ''}</div>
      <div class="rc-bottom">
        <div class="rc-sig"><div class="rc-lbl">${esc(t('prPayer'))}</div><div class="rc-sigline"></div></div>
        <div class="rc-sig"><div class="rc-lbl">${esc(t('prRecv'))}</div><div class="rc-signame">${esc(r.receivedBy || '')}</div><div class="rc-sigline"></div></div>
        <div class="rc-totalbox"><div class="rc-tl">${esc(t('grandTotal'))}</div><div class="rc-tv"><span class="d">${esc(sym)}</span><span class="v${tot.length > 7 ? ' long' : ''}">${tot}</span></div></div>
      </div>
    </div>
    <div class="rc-tear"><span class="rc-scissors">✂</span></div>
    <div class="rc-stub">
      <div class="s-brand">CENTRO TOWER</div><div class="s-copy">${esc(t('stubCopy'))}</div>
      <div class="s-no">${esc(r.no)}</div>${r.cancelled ? `<div class="s-void">${esc(t('void'))}</div>` : ''}
      <div class="s-lbl">${esc(t('grandTotal'))}</div><div class="s-total"><span class="d">${esc(sym)}</span><span class="v${tot.length > 7 ? ' long' : ''}">${tot}</span></div>
      <div class="s-field"><div class="s-lbl">${esc(t('stubApt'))}</div><div class="s-val">${esc(r.apt || '')}</div></div>
      <div class="s-field"><div class="s-lbl">${esc(t('stubName'))}</div><div class="s-val">${esc(r.name || '')}</div></div>
      <div class="s-field"><div class="s-lbl">${esc(t('stubMonths'))}</div><div class="s-val small">${esc(months)}</div></div>
      <div class="s-field"><div class="s-lbl">${esc(t('stubDate'))}</div><div class="s-val" dir="ltr">${esc(fmtDate(r.date))}</div></div>
    </div></div>`;
}
function openPreview(rec) {
  PREVIEW_REC = rec;
  $('#paperSel').value = store.get(paperKey) === 'A4' ? 'A4' : 'A5';
  $('#preview').hidden = false;
  pushOverlay('preview');
  renderPreview();
}
function renderPreview() {
  const sheet = $('#pvSheet');
  sheet.innerHTML = receiptSheetHtml(PREVIEW_REC);
  sheet.style.width = $('#paperSel').value === 'A4' ? '21cm' : '21cm';
  sheet.style.minHeight = $('#paperSel').value === 'A4' ? '29.7cm' : '14.8cm';
  sheet.style.transform = '';
  const avail = $('.preview-body').clientWidth - 40;
  const scale = Math.min(1, avail / sheet.offsetWidth);
  sheet.style.transform = scale < 1 ? `scale(${scale})` : '';
  sheet.style.marginBottom = scale < 1 ? `${-(1 - scale) * sheet.offsetHeight}px` : '';
}
function doPrint(html, kind) {
  setPageCss(kind);
  $('#print-root').innerHTML = html;
  setTimeout(() => { window.print(); }, 50);
}
function printReport(html) { doPrint(html, 'report'); }
window.addEventListener('afterprint', () => { $('#print-root').innerHTML = ''; });

// ====================================================================== Screen: settings (admin)
async function openSettings() {
  if (!ADMIN) {
    const ok = await promptModal(t('adminTitle'), t('adminAsk'), async (pw) => {
      try { ADMIN = (await api('POST', '/api/admin/unlock', { password: pw })).adminToken; return null; } catch (e) { return errText(e); }
    });
    if (!ok) return;
  }
  show('settings');
  renderSettings();
}
const TABS = ['book', 'apts', 'users', 'data', 'texts', 'audit'];
const TAB_LBL = { book: 'tabBook', apts: 'tabApts', users: 'tabUsers', data: 'tabData', texts: 'tabTexts', audit: 'tabAudit' };
async function renderSettings() {
  const v = $('#view-settings');
  v.innerHTML = backBar(esc(t('adminTitle'))) +
    `<div class="tabs">${TABS.map((k) => `<button class="tab ${S.tab === k ? 'on' : ''}" data-tab="${k}">${esc(t(TAB_LBL[k]))}</button>`).join('')}</div><div id="sBody" class="view"></div>`;
  $$('.tab', v).forEach((b) => { b.onclick = () => { S.tab = b.dataset.tab; renderSettings(); }; });
  const body = $('#sBody');
  try {
    if (S.tab === 'book') await tabBook(body);
    if (S.tab === 'apts') await tabApts(body);
    if (S.tab === 'users') await tabUsers(body);
    if (S.tab === 'data') await tabData(body);
    if (S.tab === 'texts') tabTexts(body);
    if (S.tab === 'audit') await tabAudit(body);
  } catch (e) {
    if (e.error === 'needAdmin') { show('receipt'); openSettings(); return; }
    body.innerHTML = `<div class="card err-msg">${esc(errText(e))}</div>`;
  }
}
async function tabBook(body) {
  const s = await api('GET', '/api/admin/settings');
  body.innerHTML = `<div class="card"><div class="form-grid">
      <div class="field"><label>${esc(t('lblPrefix'))}</label><input id="bPrefix" value="${esc(s.prefix)}" maxlength="10" dir="ltr"></div>
      <div class="field"><label>${esc(t('lblNextNo'))}</label><input id="bNext" value="${s.nextNo}" inputmode="numeric" dir="ltr"></div>
      <button class="btn btn-navy" id="bSaveBook">${esc(t('btnSave'))}</button></div>
      <p class="info-line" style="font-size:16px">${esc(t('nextPreview', { no: s.preview }))}</p>
      <p class="muted">${esc(t('bookHint'))}</p><div id="bMsg"></div></div>
    <div class="card"><div class="form-grid">
      <div class="field"><label>${esc(t('lblNewPw'))}</label><input id="bPw" type="password" autocomplete="new-password"></div>
      <button class="btn btn-white" id="bSavePw">${esc(t('btnChangePw'))}</button></div><div id="pwMsg"></div></div>
    <div class="card"><b>${esc(t('lanUrl'))}</b><div class="mono" style="font-size:18px;margin-top:6px">${s.lanUrls.map(esc).join('<br>') || '-'}</div></div>`;
  $('#bSaveBook').onclick = async () => {
    try { const r = await api('PUT', '/api/admin/book', { prefix: $('#bPrefix').value, nextNo: normDigits($('#bNext').value) }); $('#bMsg').innerHTML = `<span class="ok-msg">${esc(t('settingsSaved'))} — ${esc(t('nextPreview', { no: r.preview }))}</span>`; }
    catch (e) { $('#bMsg').innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; }
  };
  $('#bSavePw').onclick = async () => {
    try { await api('PUT', '/api/admin/password', { password: $('#bPw').value }); $('#bPw').value = ''; $('#pwMsg').innerHTML = `<span class="ok-msg">${esc(t('settingsSaved'))}</span>`; }
    catch (e) { $('#pwMsg').innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; }
  };
}
async function tabApts(body) {
  const list = await api('GET', '/api/admin/apartments');
  const row = (a) => `<tr data-apt="${esc(a.apt)}"><td class="no">${esc(a.apt)}</td>
      <td><input data-f="floor" value="${esc(a.floor || '')}" maxlength="20"></td>
      <td><input data-f="owner" value="${esc(a.owner || '')}" maxlength="120"></td>
      <td><input data-f="tenant" value="${esc(a.tenant || '')}" maxlength="120"></td>
      <td><input data-f="phone" value="${esc(a.phone || '')}" maxlength="40" dir="ltr"></td>
      <td><input data-f="active" type="checkbox" ${a.active ? 'checked' : ''} style="width:auto"></td>
      <td class="start muted">${esc(a.name || '')}</td>
      <td><button class="btn btn-navy btn-sm" data-save>${esc(t('btnSave'))}</button></td></tr>`;
  body.innerHTML = `<div class="card"><div class="form-grid">
      <div class="field"><label>${esc(t('colApt'))}</label><input id="nApt" maxlength="20"></div>
      <div class="field"><label>${esc(t('colFloor'))}</label><input id="nFloor" maxlength="20"></div>
      <div class="field"><label>${esc(t('colOwner'))}</label><input id="nOwner" maxlength="120"></div>
      <div class="field"><label>${esc(t('colTenant'))}</label><input id="nTenant" maxlength="120"></div>
      <div class="field"><label>${esc(t('colPhone'))}</label><input id="nPhone" maxlength="40" dir="ltr"></div>
      <button class="btn btn-gold" id="nAdd">${esc(t('btnAdd'))}</button></div><div id="aMsg" style="margin-top:8px"></div>
      <p class="muted" style="margin-bottom:0">${esc(t('aptsHint'))}</p></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>${esc(t('colApt'))}</th><th>${esc(t('colFloor'))}</th><th>${esc(t('colOwner'))}</th>
      <th>${esc(t('colTenant'))}</th><th>${esc(t('colPhone'))}</th><th>${esc(t('colActive'))}</th><th>${esc(t('colName'))}</th><th></th></tr></thead>
      <tbody>${list.map(row).join('') || `<tr><td colspan="8" class="empty">-</td></tr>`}</tbody></table></div>`;
  $('#nAdd').onclick = async () => {
    try {
      await api('POST', '/api/admin/apartments', { apt: $('#nApt').value, floor: $('#nFloor').value, owner: $('#nOwner').value, tenant: $('#nTenant').value, phone: $('#nPhone').value });
      await refreshApts(); renderSettings();
    } catch (e) { $('#aMsg').innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; }
  };
  $$('button[data-save]', body).forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest('tr');
      const val = (f) => $(`[data-f="${f}"]`, tr);
      try {
        await api('PUT', `/api/admin/apartments/${encodeURIComponent(tr.dataset.apt)}`, {
          floor: val('floor').value, owner: val('owner').value, tenant: val('tenant').value, phone: val('phone').value, active: val('active').checked });
        b.textContent = '✓'; refreshApts();
      } catch (e) { $('#aMsg').innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; }
    };
  });
}
async function tabUsers(body) {
  const list = await api('GET', '/api/admin/users');
  body.innerHTML = `<div class="card"><div class="form-grid">
      <div class="field"><label>${esc(t('lblUser'))}</label><input id="uName" maxlength="60"></div>
      <div class="field"><label>${esc(t('lblPinOpt'))}</label><input id="uPin" type="password" inputmode="numeric" autocomplete="new-password" dir="ltr"></div>
      <button class="btn btn-gold" id="uAdd">${esc(t('btnAdd'))}</button></div><div id="uMsg" style="margin-top:8px"></div>
      <p class="muted" style="margin-bottom:0">${esc(t('usersHint'))}</p></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>${esc(t('lblUser'))}</th><th>${esc(t('lblPin'))}</th><th>${esc(t('colActive'))}</th><th></th></tr></thead>
      <tbody>${list.map((u) => `<tr data-id="${u.id}"><td class="start"><b>${esc(u.name)}</b></td>
        <td><input data-f="pin" type="password" inputmode="numeric" autocomplete="new-password" placeholder="${esc(u.hasPin ? '•••• ' + t('pinKeep') : '')}" dir="ltr"></td>
        <td><input data-f="active" type="checkbox" ${u.active ? 'checked' : ''} style="width:auto"></td>
        <td><button class="btn btn-navy btn-sm" data-save>${esc(t('btnSave'))}</button></td></tr>`).join('')}</tbody></table></div>`;
  $('#uAdd').onclick = async () => {
    try { await api('POST', '/api/admin/users', { name: $('#uName').value, pin: $('#uPin').value }); renderSettings(); }
    catch (e) { $('#uMsg').innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; }
  };
  $$('button[data-save]', body).forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest('tr');
      try {
        await api('PUT', `/api/admin/users/${tr.dataset.id}`, { pin: $('[data-f="pin"]', tr).value || undefined, active: $('[data-f="active"]', tr).checked });
        b.textContent = '✓';
      } catch (e) { $('#uMsg').innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; }
    };
  });
}
// header warning when there is no up-to-date copy outside this disk
function setBackupWarning(w) {
  const el = $('#backupWarn');
  if (!el) return;
  BACKUP_WARNING = w || null;
  el.hidden = !w;
  if (w) el.textContent = t(w.key, w.params);
}
let BACKUP_WARNING = null;

function mirrorStatusHtml(m) {
  if (!m.dirs.length) return '';
  return `<ul class="mstat">${m.dirs.map((d) => {
    const s = m.status[d] || {};
    const err = s.error ? `<span class="err-msg">✗ ${esc(t(s.error.code, { dir: d, msg: s.error.msg }))}</span>` : '';
    const ok = s.lastOk ? `<span class="ok-msg">${esc(t('mirrorOk', { at: `${fmtDate(s.lastOk)} ${s.lastOk.slice(11, 16)}` }))}</span>` : `<span class="muted">${esc(t('mirrorNever'))}</span>`;
    return `<li><span class="mono">${esc(d)}</span> — ${ok} ${err}</li>`;
  }).join('')}</ul>`;
}
async function mirrorCard(el) {
  const m = await api('GET', '/api/admin/mirror');
  setBackupWarning(m.warning);
  el.innerHTML = `<div class="card-h">${esc(t('mirrorTitle'))}</div><p class="muted" style="margin-top:0">${esc(t('mirrorHint'))}</p>
    <div class="field"><label>${esc(t('lblMirrorDirs'))}</label><textarea id="mDirs" class="mirror-dirs" spellcheck="false">${esc(m.dirs.join('\n'))}</textarea></div>
    ${m.suggestions.length ? `<div class="sug"><span class="muted">${esc(t('mirrorSuggest'))}</span>${m.suggestions.map((s) =>
      `<button class="btn btn-white btn-sm" data-sug="${esc(s.dir)}" title="${esc(t(s.kind))}">${esc(t(s.kind))}: ${esc(s.dir)}</button>`).join('')}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-navy" id="mSave">${esc(t('btnSave'))}</button>
      <button class="btn btn-white" id="mRun" ${m.dirs.length ? '' : 'disabled'}>${esc(t('btnMirrorNow'))}</button></div>
    <div id="mMsg"></div>${mirrorStatusHtml(m)}`;
  $$('[data-sug]', el).forEach((b) => {
    b.onclick = () => {
      const ta = $('#mDirs');
      const lines = ta.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (!lines.some((x) => x.toLowerCase() === b.dataset.sug.toLowerCase())) lines.push(b.dataset.sug);
      ta.value = lines.join('\n');
    };
  });
  $('#mSave').onclick = async () => {
    $('#mSave').disabled = true;
    try {
      await api('PUT', '/api/admin/mirror', { dirs: $('#mDirs').value.split(/\r?\n/) });
      await mirrorCard(el);
      $('#mMsg').innerHTML = `<span class="ok-msg">${esc(t('settingsSaved'))}</span>`;
    } catch (e) { $('#mMsg').innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; $('#mSave').disabled = false; }
  };
  $('#mRun').onclick = async () => {
    $('#mRun').disabled = true;
    try { await api('POST', '/api/admin/backup'); await mirrorCard(el); }
    catch (e) { $('#mMsg').innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; $('#mRun').disabled = false; }
  };
}

async function tabData(body) {
  const s = await api('GET', '/api/admin/settings');
  body.innerHTML = `<div class="card" id="mirrorCard"></div><div class="card"><div class="card-h">${esc(t('importTitle'))}</div><p class="muted" style="margin-top:0">${esc(t('importHint'))}</p>
      <div class="form-grid"><input type="file" id="iFile" accept=".accdb,.mdb,.csv,.txt"><button class="btn btn-gold" id="iGo">${esc(t('btnImport'))}</button></div>
      <div id="iRes" style="margin-top:10px"></div></div>
    <div class="card"><div class="card-h">${esc(t('backupTitle'))}</div><p class="muted" style="margin-top:0">${esc(t('backupHint'))}</p>
      <div class="mono muted" style="font-size:12px;margin-bottom:8px">${esc(s.dataDir)}</div>
      <button class="btn btn-navy" id="bkGo">${esc(t('btnBackup'))}</button><div id="bkMsg" style="margin:8px 0"></div>
      <div class="table-wrap"><table class="data"><tbody>${s.backups.map((b) => `<tr><td class="mono start">${esc(b.file)}</td>
        <td class="muted" dir="ltr">${Math.max(1, Math.round(b.size / 1024))} KB</td><td><button class="btn btn-white btn-sm" data-dl="${esc(b.file)}">${esc(t('btnDownload'))}</button></td></tr>`).join('') || '<tr><td class="empty">-</td></tr>'}</tbody></table></div></div>
    <div class="card"><div class="card-h">${esc(t('exportTitle'))}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-navy" id="exX">Excel (.xlsx)</button><button class="btn btn-white" id="exC">CSV</button></div><div id="exMsg"></div></div>`;
  $('#iGo').onclick = async () => {
    const f = $('#iFile').files[0];
    if (!f) return;
    $('#iRes').innerHTML = `<span class="muted">${esc(t('importing'))}</span>`;
    $('#iGo').disabled = true;
    try {
      const r = await api('POST', `/api/admin/import?name=${encodeURIComponent(f.name)}`, f);
      $('#iRes').innerHTML = `<div class="import-result"><div class="ok-msg">${esc(t('importDone', { n: r.imported, s: r.skipped.length, next: r.nextNo }))}</div>
        ${r.skipped.length ? `<b>${esc(t('impSkipped'))} (${r.skipped.length})</b><ul>${r.skipped.map((x) => `<li>#${x.row} <span class="mono">${esc(x.no || '')}</span> — ${esc(t(x.reason))}</li>`).join('')}</ul>` : ''}
        ${r.warnings.length ? `<b>${esc(t('impWarnings'))} (${r.warnings.length})</b><ul>${r.warnings.map((x) => `<li><span class="mono">${esc(x.no)}</span> — ${esc(t(x.key, x.params))}</li>`).join('')}</ul>` : ''}</div>`;
      refreshReceipts(); refreshApts();
    } catch (e) { $('#iRes').innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; }
    finally { $('#iGo').disabled = false; }
  };
  $('#bkGo').onclick = async () => {
    try { const r = await api('POST', '/api/admin/backup'); await tabData(body); $('#bkMsg').innerHTML = `<span class="ok-msg">${esc(t('backupDone', { f: r.file }))}</span>`; }
    catch (e) { $('#bkMsg').innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; }
  };
  $$('[data-dl]', body).forEach((b) => { b.onclick = async () => download(await api('GET', `/api/admin/backups/${encodeURIComponent(b.dataset.dl)}`, undefined, { blob: true })); });
  const ex = async (fmt) => { try { download(await api('GET', `/api/admin/export.${fmt}`, undefined, { blob: true })); } catch (e) { $('#exMsg').innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; } };
  $('#exX').onclick = () => ex('xlsx');
  $('#exC').onclick = () => ex('csv');
  const mc = $('#mirrorCard');
  mc.innerHTML = `<div class="muted">…</div>`;
  mirrorCard(mc).catch((e) => { mc.innerHTML = `<span class="err-msg">${esc(errText(e))}</span>`; });
}
function tabTexts(body) {
  const keys = Object.keys(TEXTS);
  body.innerHTML = `<div class="page-h"><input id="tFilter" type="search" placeholder="🔍" style="max-width:320px"><span class="muted">${esc(t('textsHint'))}</span></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>${esc(t('colKey'))}</th><th>کوردی</th><th>العربية</th><th></th></tr></thead>
    <tbody>${keys.map((k) => `<tr data-k="${esc(k)}"><td class="mono start" style="font-size:12px">${esc(k)}</td>
      <td><textarea data-f="ku">${esc(TEXTS[k][0])}</textarea></td><td><textarea data-f="ar">${esc(TEXTS[k][1])}</textarea></td>
      <td style="white-space:nowrap"><button class="btn btn-navy btn-sm" data-save>${esc(t('btnSave'))}</button>
        <button class="btn btn-white btn-sm" data-reset>${esc(t('btnReset'))}</button></td></tr>`).join('')}</tbody></table></div>`;
  $('#tFilter').oninput = () => {
    const q = $('#tFilter').value.toLowerCase();
    $$('tr[data-k]', body).forEach((tr) => { tr.hidden = q && !(tr.dataset.k.toLowerCase().includes(q) || $$('textarea', tr).some((x) => x.value.toLowerCase().includes(q))); });
  };
  const after = (texts, b) => { TEXTS = texts; applyLang(); relabelReceiptForm(); renderStatus(); b.textContent = '✓'; };
  $$('[data-save]', body).forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest('tr');
      try { after(await api('PUT', `/api/admin/texts/${encodeURIComponent(tr.dataset.k)}`, { ku: $('[data-f="ku"]', tr).value, ar: $('[data-f="ar"]', tr).value }), b); }
      catch (e) { alert(errText(e)); }
    };
  });
  $$('[data-reset]', body).forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest('tr');
      try {
        const texts = await api('POST', `/api/admin/texts/${encodeURIComponent(tr.dataset.k)}/reset`);
        $('[data-f="ku"]', tr).value = texts[tr.dataset.k][0]; $('[data-f="ar"]', tr).value = texts[tr.dataset.k][1];
        after(texts, b);
      } catch (e) { alert(errText(e)); }
    };
  });
}
// database field name → label in the current language (M2 → "مانگ 2")
function fieldLabel(f) {
  if (!f) return '';
  const map = { ReceiptDate: 'lblDate', CustomerName: 'lblName', CustType: 'typeLbl', ApartmentNo: 'lblApt', Currency: 'lblCurrency', ReceivedBy: 'lblRecv', Notes: 'lblNotes', Cancelled: 'void', Prefix: 'lblPrefix', NextNo: 'lblNextNo' };
  if (map[f]) return t(map[f]);
  const m = /^([MYA])([123])$/.exec(f);
  if (m) return `${t({ M: 'colMonth', Y: 'colYear', A: 'colAmount' }[m[1]])} ${m[2]}`;
  return f;
}
async function tabAudit(body, q = '') {
  const list = await api('GET', `/api/admin/audit?q=${encodeURIComponent(q)}`);
  const act = { create: 'actCreate', edit: 'actEdit', void: 'actVoid', import: 'actImport', settings: 'actSettings' };
  body.innerHTML = `<div class="page-h"><input id="auQ" type="search" placeholder="🔍" value="${esc(q)}" style="max-width:320px"></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>${esc(t('colWhen'))}</th><th>${esc(t('colWho'))}</th><th>${esc(t('colAction'))}</th>
      <th>${esc(t('colNo'))}</th><th>${esc(t('colField'))}</th><th>${esc(t('colOld'))}</th><th>${esc(t('colNew'))}</th></tr></thead>
    <tbody>${list.map((a) => `<tr><td dir="ltr" style="white-space:nowrap">${esc(fmtDate(a.At))} ${esc(a.At.slice(11, 16))}</td><td>${esc(a.UserName || '')}</td>
      <td>${esc(t(act[a.Action] || a.Action))}</td><td class="no">${a.ReceiptID ? `<button class="linkish" data-open="${a.ReceiptID}">${esc(a.ReceiptNo)}</button>` : ''}</td>
      <td>${esc(fieldLabel(a.Field))}</td><td class="start">${esc(a.OldValue ?? '')}</td><td class="start">${esc(a.NewValue ?? '')}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">-</td></tr>'}</tbody></table></div>`;
  let timer;
  $('#auQ').oninput = () => { clearTimeout(timer); timer = setTimeout(async () => { const v = $('#auQ').value; await tabAudit(body, v); const i = $('#auQ'); i.focus(); i.setSelectionRange(v.length, v.length); }, 300); };
}

// ====================================================================== wiring
function wire() {
  $('#btnLang').onclick = toggleLang;
  $('#bNew').onclick = onNew;
  $('#bSave').onclick = onSave;
  $('#bEdit').onclick = onEdit;
  $('#bPrint').onclick = onPrint;
  $('#bList').onclick = () => { R.armVoid = false; openList(); };
  $('#bMonthly').onclick = () => { R.armVoid = false; openMonthly(); };
  $('#bVoid').onclick = onVoid;
  $('#btnAptReport').onclick = () => { R.armVoid = false; openAptReport(CURRENT_VIEW === 'receipt' ? normDigits($('#fApt').value).trim() : A.apt); };
  $('#btnSettings').onclick = openSettings;
  $('#backupWarn').onclick = () => { S.tab = 'data'; openSettings(); };
  // re-check the backup warning every 30 minutes (USB unplugged, etc.)
  setInterval(async () => { try { setBackupWarning((await api('GET', '/api/bootstrap')).backupWarning); } catch { /* offline */ } }, 30 * 60 * 1000);
  $('#btnLogout').onclick = async () => {
    if (!(await leaveReceipt())) { show('receipt'); return; }
    try { await api('POST', '/api/logout'); } catch { /* ignore */ }
    TOKEN = null; ADMIN = null; store.set('centroToken', null); showGate();
  };

  // receipt form: dirty tracking + live total
  const form = $('#view-receipt');
  form.addEventListener('input', (e) => {
    if (!e.target.classList.contains('ed')) return;
    if (R.mode === 'new' || R.mode === 'editing') R.dirty = true;
    if (e.target.id === 'fName') R.autoName = false;
    if (/^fA\d$/.test(e.target.id) || e.target.id === 'fCur') updateTotal();
  });
  form.addEventListener('change', (e) => { if (e.target.id === 'fApt') onAptChange(); });
  $('#fDatePick').onclick = () => {
    const n = $('#fDateNative');
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(normDigits($('#fDate').value));
    n.value = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : TODAY;
    try { n.showPicker(); } catch { n.click(); }
  };
  $('#fDateNative').onchange = () => { const v = $('#fDateNative').value; if (v) { $('#fDate').value = fmtDate(v); R.dirty = true; } };
  // when a month is picked on an empty line, default its year to the current year
  for (let i = 1; i <= 3; i++) {
    $('#fM' + i).addEventListener('change', () => { if ($('#fM' + i).value && !$('#fY' + i).value) $('#fY' + i).value = String(curYear()); });
  }

  // header search
  const find = $('#find');
  find.addEventListener('focus', () => { FIND_SEL = -1; renderFind(); });
  find.addEventListener('input', () => { FIND_SEL = 0; renderFind(); });
  find.addEventListener('keydown', (e) => {
    const rows = $$('#findList .dd-row[data-id]');
    if (e.key === 'ArrowDown') { FIND_SEL = Math.min(rows.length - 1, FIND_SEL + 1); renderFind(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { FIND_SEL = Math.max(0, FIND_SEL - 1); renderFind(); e.preventDefault(); }
    else if (e.key === 'Enter' && rows[Math.max(0, FIND_SEL)]) { e.preventDefault(); pickFind(rows[Math.max(0, FIND_SEL)].dataset.id); }
    else if (e.key === 'Escape') { closeFind(); find.blur(); }
  });
  $('#findList').addEventListener('mousedown', (e) => { const row = e.target.closest('.dd-row[data-id]'); if (row) { e.preventDefault(); pickFind(row.dataset.id); } });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.search-box')) closeFind(); });
  function pickFind(id) { closeFind(); find.value = ''; find.blur(); openReceipt(Number(id)); }

  // delegated: back buttons, double-click to open receipts / apartments, links
  document.addEventListener('click', (e) => {
    const back = e.target.closest('[data-act="back"]');
    if (back) { closeModal(); show('receipt'); return; }
    const link = e.target.closest('button[data-open]');
    if (link) { openReceipt(Number(link.dataset.open)); return; }
    if (e.target.closest('[data-close]')) closeModalUI();
  });
  document.addEventListener('dblclick', (e) => {
    const o = e.target.closest('td[data-open]');
    if (o) { openReceipt(Number(o.dataset.open)); return; }
    const a = e.target.closest('td[data-apt]');
    if (a && a.dataset.apt) { closeModal(); openAptReport(a.dataset.apt); }
  });
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModalUI(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#preview').hidden) closePreviewUI(); else if (!$('#modal').hidden) closeModalUI(); }
  });

  // print preview
  $('#pvClose').onclick = closePreviewUI;
  $('#pvPrint').onclick = () => doPrint(receiptSheetHtml(PREVIEW_REC), 'receipt');
  $('#paperSel').onchange = () => { store.set(paperKey, $('#paperSel').value); renderPreview(); };
  window.addEventListener('resize', () => { if (!$('#preview').hidden) renderPreview(); });
  window.addEventListener('beforeunload', (e) => {
    if ((R.mode === 'new' && !isBlank()) || (R.mode === 'editing' && R.dirty)) { e.preventDefault(); e.returnValue = ''; }
  });
}

store = storeImpl();
boot();
