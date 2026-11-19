import { firebaseConfig } from './firebase-config.js';
import { balances, settle, expenseShares, toJPY } from './calc.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const app = document.getElementById('app');
const dlg = document.getElementById('expDlg');
const form = document.getElementById('expForm');

// ---------- 小工具 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = n => '¥' + Math.round(n).toLocaleString('ja-JP');
const ntd = n => 'NT$' + Math.round(n).toLocaleString('zh-TW');
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const randomId = (n = 12) => {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(n))].map(x => a[x % a.length]).join('');
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 無痕模式等情況，忽略 */ } },
};
const weekday = s => { const d = new Date(s + 'T00:00:00'); return isNaN(d) ? '' : '日一二三四五六'[d.getDay()]; };
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2000);
}

// ---------- 資料存放：Firebase 或示範模式 ----------
const configured = c => c && c.apiKey && c.projectId && !String(c.apiKey).startsWith('請');

async function firebaseStore() {
  const { initializeApp } = await import(FB + 'firebase-app.js');
  const fs = await import(FB + 'firebase-firestore.js');
  const db = fs.getFirestore(initializeApp(firebaseConfig));
  const tripRef = id => fs.doc(db, 'trips', id);
  const expCol = id => fs.collection(db, 'trips', id, 'expenses');
  return {
    async createTrip(data) { const id = randomId(); await fs.setDoc(tripRef(id), { ...data, createdAt: Date.now() }); return id; },
    watchTrip(id, cb, err) { return fs.onSnapshot(tripRef(id), s => cb(s.exists() ? s.data() : null), err); },
    watchExpenses(id, cb, err) { return fs.onSnapshot(expCol(id), s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), err); },
    addExpense(t, e) { return fs.addDoc(expCol(t), { ...e, createdAt: Date.now() }); },
    updateExpense(t, id, e) { return fs.updateDoc(fs.doc(db, 'trips', t, 'expenses', id), e); },
    deleteExpense(t, id) { return fs.deleteDoc(fs.doc(db, 'trips', t, 'expenses', id)); },
    updateTrip(t, p) { return fs.updateDoc(tripRef(t), p); },
  };
}

function demoStore() {
  const trips = {}, exps = {}, lt = {}, le = {};
  const tripOf = id => (trips[id] ? structuredClone(trips[id]) : null);
  const listOf = id => Object.entries(exps[id] || {}).map(([k, v]) => ({ id: k, ...structuredClone(v) }));
  const emitT = id => (lt[id] || []).forEach(cb => cb(tripOf(id)));
  const emitE = id => (le[id] || []).forEach(cb => cb(listOf(id)));
  const sub = (map, id, cb, first) => { (map[id] ||= []).push(cb); setTimeout(() => cb(first())); return () => { map[id] = map[id].filter(f => f !== cb); }; };
  return {
    demo: true,
    async createTrip(d) { const id = randomId(); trips[id] = { ...d, createdAt: Date.now() }; exps[id] = {}; return id; },
    watchTrip(id, cb) { return sub(lt, id, cb, () => tripOf(id)); },
    watchExpenses(id, cb) { return sub(le, id, cb, () => listOf(id)); },
    async addExpense(t, e) { (exps[t] ||= {})[randomId()] = { ...e, createdAt: Date.now() }; emitE(t); },
    async updateExpense(t, id, e) { Object.assign(exps[t][id], e); emitE(t); },
    async deleteExpense(t, id) { delete exps[t][id]; emitE(t); },
    async updateTrip(t, p) { Object.assign(trips[t], p); emitT(t); },
  };
}

// ---------- 狀態 ----------
let store = null, storeError = null;
let unsub = [];
const S = { tripId: null, trip: undefined, expenses: [], tab: 'list', error: null, pending: false };
const meKey = () => 'me:' + S.tripId;
const getMe = () => ls.get(meKey(), '');
const nameOf = id => S.trip?.members.find(m => m.id === id)?.name || '（已移除）';
function rememberTrip(id, name) {
  const list = ls.get('recentTrips', []).filter(x => x.id !== id);
  list.unshift({ id, name, at: Date.now() });
  ls.set('recentTrips', list.slice(0, 8));
}

// ---------- 路由 ----------
function route() {
  unsub.forEach(f => f && f()); unsub = [];
  if (dlg.open) dlg.close();
  const m = location.hash.match(/^#\/t\/([a-z0-9]{6,32})/);
  if (!m) { S.tripId = null; renderHome(); return; }
  S.tripId = m[1]; S.trip = undefined; S.expenses = []; S.error = null; S.tab = 'list';
  renderTrip();
  if (!store) return;
  const timer = setTimeout(() => { if (S.trip === undefined) { S.error = 'timeout'; renderTrip(); } }, 10000);
  unsub.push(() => clearTimeout(timer));
  const onErr = e => { clearTimeout(timer); console.error(e); S.error = e?.code || 'error'; renderTrip(); };
  unsub.push(store.watchTrip(S.tripId, t => {
    clearTimeout(timer); S.trip = t; S.error = null;
    if (t) rememberTrip(S.tripId, t.name);
    renderTrip();
  }, onErr));
  unsub.push(store.watchExpenses(S.tripId, list => { S.expenses = list; renderTrip(); }, onErr));
}

// ---------- 首頁 ----------
function memberInput(v = '') {
  return `<div class="member-row"><input name="member" maxlength="20" placeholder="名字" value="${esc(v)}"><button type="button" data-act="rm-member" aria-label="移除">✕</button></div>`;
}

function renderHome() {
  document.title = '旅費分帳';
  const recent = ls.get('recentTrips', []);
  app.innerHTML = `
    <header class="hero">
      <h1>旅費分帳 ✈️</h1>
      <p>誰先付、怎麼分、最後誰給誰多少，交給它算。大家用同一個連結一起記。</p>
    </header>
    ${storeError ? `<div class="card"><b>連不上資料庫</b><p class="note">${esc(storeError)}</p></div>` : ''}
    <section class="card">
      <h2>開一本新帳</h2>
      <form id="createForm" novalidate>
        <label>旅行名稱<input name="name" maxlength="40" placeholder="例：東京五天四夜" required></label>
        <fieldset>
          <legend>旅伴（包含你自己）</legend>
          <div id="memberInputs">${memberInput()}${memberInput()}${memberInput()}</div>
          <button type="button" class="link" data-act="add-member-input">＋ 再加一位</button>
        </fieldset>
        <label for="rateIn">匯率</label>
        <div class="inline">1 日圓 = <input id="rateIn" name="rate" type="number" inputmode="decimal" step="any" min="0" value="0.21"> 台幣</div>
        <p class="note">請依出發時的匯率調整，之後也能改。</p>
        <p class="err" id="createErr"></p>
        <button class="primary block" type="submit">建立並取得分享連結</button>
      </form>
    </section>
    ${recent.length ? `<section class="card recent"><h2>最近開過的帳本</h2>${recent.map(r => `<a href="#/t/${esc(r.id)}"><b>${esc(r.name)}</b><span>›</span></a>`).join('')}</section>` : ''}
  `;
}

async function createTrip(f) {
  const err = document.getElementById('createErr');
  const name = f.name.value.trim();
  const names = [...f.querySelectorAll('input[name="member"]')].map(i => i.value.trim()).filter(Boolean);
  const rate = Number(f.rate.value);
  if (!name) return (err.textContent = '幫這趟旅行取個名字吧');
  if (names.length < 2) return (err.textContent = '至少要兩個人才需要分帳喔');
  if (new Set(names).size !== names.length) return (err.textContent = '有名字重複了，加個暱稱區分一下');
  if (!(rate > 0)) return (err.textContent = '匯率要是大於 0 的數字');
  const btn = f.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = '建立中…';
  try {
    const members = names.map(n => ({ id: randomId(6), name: n }));
    const id = await store.createTrip({ name, members, rate });
    location.hash = '#/t/' + id;
    S.justCreated = true;
  } catch (e) {
    console.error(e);
    err.textContent = '建立失敗：' + (e.code || e.message || '請稍後再試');
    btn.disabled = false; btn.textContent = '建立並取得分享連結';
  }
}

// ---------- 帳本頁 ----------
const isTyping = () => {
  const a = document.activeElement;
  return a && app.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT') && a.id !== 'meSel';
};
app.addEventListener('focusout', () => setTimeout(() => { if (S.pending && !isTyping()) { S.pending = false; renderTrip(); } }, 0));

function renderTrip() {
  if (!S.tripId) return;
  if (isTyping()) { S.pending = true; return; }
  if (storeError) { app.innerHTML = `<div class="center"><p>連不上資料庫 😢</p><p class="note">${esc(storeError)}</p><a href="#/">回首頁</a></div>`; return; }
  if (S.error) {
    const msg = S.error === 'timeout' ? '等太久了，可能是網路不穩。' : S.error === 'permission-denied' ? '沒有權限讀取這本帳。' : '讀取時出了問題。';
    app.innerHTML = `<div class="center"><p>${msg}</p><p><button class="ghost" data-act="reload">再試一次</button></p><a href="#/">回首頁</a></div>`;
    return;
  }
  if (S.trip === undefined) { app.innerHTML = '<p class="center">載入帳本中…</p>'; return; }
  if (S.trip === null) { app.innerHTML = '<div class="center"><p>找不到這本帳 🤔</p><p class="note">確認一下連結有沒有複製完整。</p><a href="#/">回首頁</a></div>'; return; }

  const t = S.trip, me = getMe();
  document.title = t.name + '｜旅費分帳';
  const tabs = [['list', '帳目'], ['settle', '結算'], ['settings', '設定']];
  app.innerHTML = `
    <header class="top">
      <a href="#/" class="back" aria-label="回首頁">‹</a>
      <div class="titles"><h1>${esc(t.name)}</h1><p class="sub">${t.members.length} 人 · 1 日圓 = ${esc(t.rate)} 台幣</p></div>
      <button class="ghost" data-act="share">分享</button>
    </header>
    <div class="whoami"><label for="meSel">我是</label>
      <select id="meSel"><option value="">— 選你自己 —</option>${t.members.map(m => `<option value="${esc(m.id)}" ${m.id === me ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
    </div>
    <nav class="tabs" role="tablist">${tabs.map(([k, v]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${v}</button>`).join('')}</nav>
    <main>${S.tab === 'list' ? listView() : S.tab === 'settle' ? settleView() : settingsView()}</main>
    ${S.tab === 'list' ? '<button class="fab" data-act="add">＋ 記一筆</button>' : ''}
  `;
  if (S.justCreated) { S.justCreated = false; S.tab = 'settings'; renderTrip(); toast('建好了！把連結傳給旅伴吧'); }
}

function money(e) {
  const jpy = toJPY(Number(e.amount), e.currency, S.trip.rate);
  return e.currency === 'TWD'
    ? `<b>${ntd(e.amount)}</b><span>≈ ${yen(jpy)}</span>`
    : `<b>${yen(e.amount)}</b><span>≈ ${ntd(jpy * S.trip.rate)}</span>`;
}

function splitText(e) {
  if (e.split?.mode === 'custom') return '自訂金額';
  const n = (e.split?.among || []).length;
  return n === S.trip.members.length ? '全員平分' : `${n} 人平分`;
}

function sortedExpenses() {
  return [...S.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

function listView() {
  const t = S.trip, me = getMe();
  const list = sortedExpenses();
  const total = list.reduce((s, e) => s + Math.round(toJPY(Number(e.amount), e.currency, t.rate)), 0);
  const bal = balances(t, list);
  let stats = `<div class="stat"><div class="k">總花費</div><div class="v">${yen(total)}</div><div class="t">≈ ${ntd(total * t.rate)}</div></div>`;
  if (me && bal[me]) {
    stats += `<div class="stat"><div class="k">我的份</div><div class="v">${yen(bal[me].owed)}</div><div class="t">我先付了 ${yen(bal[me].paid)}</div></div>`;
  }
  if (!list.length) {
    return `<div class="stats">${stats}</div><div class="empty"><div class="big">🧾</div><p>還沒有任何帳目。<br>按下面的「記一筆」開始吧！</p></div>`;
  }
  let html = `<div class="stats">${stats}</div>`;
  let day = null;
  for (const e of list) {
    if (e.date !== day) { day = e.date; html += `<div class="day">${esc(day || '未填日期')} ${day ? '（' + weekday(day) + '）' : ''}</div>`; }
    html += `<button class="exp" data-exp="${esc(e.id)}">
      <div class="l"><b>${esc(e.title)}</b><span>${esc(nameOf(e.payer))} 先付 · ${splitText(e)}</span></div>
      <div class="r">${money(e)}</div></button>`;
  }
  return html;
}

function settleView() {
  const t = S.trip;
  const bal = balances(t, S.expenses);
  const tx = settle(bal);
  const me = getMe();
  const rows = t.members.map(m => {
    const b = bal[m.id];
    const cls = b.net > 0 ? 'pos' : b.net < 0 ? 'neg' : '';
    const label = b.net > 0 ? '應收' : b.net < 0 ? '應付' : '扯平';
    return `<div class="bal"><div class="n"><b>${esc(m.name)}${m.id === me ? '（我）' : ''}</b><span>先付 ${yen(b.paid)} · 該負擔 ${yen(b.owed)}</span></div>
      <div class="amt ${cls}">${label} ${b.net ? yen(Math.abs(b.net)) : ''}<span>${b.net ? '≈ ' + ntd(Math.abs(b.net) * t.rate) : ''}</span></div></div>`;
  }).join('');
  const txHtml = tx.length
    ? tx.map(x => `<div class="tx"><div class="who"><b>${esc(nameOf(x.from))}</b><span class="arrow">→ 給 →</span><b>${esc(nameOf(x.to))}</b></div><div class="amt">${yen(x.amount)}<span>≈ ${ntd(x.amount * t.rate)}</span></div></div>`).join('')
    : '<p class="empty" style="padding:16px">目前大家扯平了 🎉</p>';
  return `
    <section class="card"><h2>最後怎麼還錢</h2>${txHtml}
      ${tx.length ? '<p class="note">已經用最少的轉帳次數排好了。台幣金額依目前設定的匯率換算。</p>' : ''}</section>
    <section class="card"><h2>每個人的狀況</h2>${rows}</section>`;
}

function settingsView() {
  const t = S.trip;
  return `
    <section class="card"><h2>分享給旅伴</h2>
      <p class="note" style="margin-top:0">拿到這個連結的人都能看、也能記帳，不用註冊。連結請只傳給一起旅行的人。</p>
      <div class="sharebox"><input id="shareUrl" readonly value="${esc(location.href.split('#')[0] + '#/t/' + S.tripId)}"><button class="primary" data-act="copy">複製</button></div>
    </section>
    <section class="card"><h2>匯率</h2>
      <form id="rateForm" class="inline" novalidate>1 日圓 = <input name="rate" type="number" inputmode="decimal" step="any" min="0" value="${esc(t.rate)}"> 台幣 <button class="ghost" type="submit">更新</button></form>
      <p class="note">換算只影響「約多少台幣」和用台幣記的帳。</p>
    </section>
    <section class="card"><h2>旅伴</h2>
      ${t.members.map(m => `<div class="bal"><div class="n"><b>${esc(m.name)}</b></div></div>`).join('')}
      <form id="memberForm" class="member-row" style="margin-top:12px" novalidate><input name="name" maxlength="20" placeholder="新增旅伴的名字"><button type="submit" aria-label="新增">＋</button></form>
      <p class="note">新加入的人不會自動被算進以前的帳目。</p>
    </section>`;
}

async function share() {
  const url = location.href.split('#')[0] + '#/t/' + S.tripId;
  if (navigator.share) {
    try { await navigator.share({ title: S.trip.name, text: `${S.trip.name} 的分帳本，一起來記帳：`, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(url);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('連結已複製'); }
  catch { const i = document.getElementById('shareUrl'); if (i) { i.select(); } toast('請手動複製連結'); }
}

// ---------- 記一筆 / 編輯 ----------
let draft = null, editingId = null;

function openExpense(exp) {
  const t = S.trip;
  editingId = exp ? exp.id : null;
  draft = exp ? structuredClone(exp) : {
    title: '', amount: '', currency: 'JPY', payer: getMe() || t.members[0].id, date: today(),
    split: { mode: 'equal', among: t.members.map(m => m.id) },
  };
  draft.split.among ||= t.members.map(m => m.id);
  draft.split.shares ||= {};
  form.innerHTML = `
    <h2>${exp ? '編輯這筆' : '記一筆'}</h2>
    <label>項目<input name="title" maxlength="60" placeholder="例：一蘭拉麵、新幹線" value="${esc(draft.title)}"></label>
    <div class="row">
      <label class="grow">金額<input name="amount" type="number" inputmode="decimal" step="any" min="0" placeholder="0" value="${esc(draft.amount)}"></label>
      <div class="seg" role="radiogroup" aria-label="幣別">
        <label><input type="radio" name="currency" value="JPY" ${draft.currency === 'JPY' ? 'checked' : ''}>日圓</label>
        <label><input type="radio" name="currency" value="TWD" ${draft.currency === 'TWD' ? 'checked' : ''}>台幣</label>
      </div>
    </div>
    <label>誰先付<select name="payer">${t.members.map(m => `<option value="${esc(m.id)}" ${m.id === draft.payer ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
    <label>日期<input name="date" type="date" value="${esc(draft.date)}"></label>
    <fieldset><legend>怎麼分</legend>
      <div class="seg" role="radiogroup" aria-label="分攤方式">
        <label><input type="radio" name="mode" value="equal" ${draft.split.mode !== 'custom' ? 'checked' : ''}>平分</label>
        <label><input type="radio" name="mode" value="custom" ${draft.split.mode === 'custom' ? 'checked' : ''}>各付各的金額</label>
      </div>
      <div id="splitArea" style="margin-top:12px"></div>
    </fieldset>
    <p class="err" id="formErr"></p>
    <div class="actions">
      ${exp ? '<button type="button" class="danger" data-act="del">刪除</button>' : ''}
      <span class="spacer"></span>
      <button type="button" data-act="cancel">取消</button>
      <button type="submit" class="primary">儲存</button>
    </div>`;
  renderSplit();
  dlg.showModal();
  if (!exp) setTimeout(() => form.title.focus(), 50);
}

function readDraft() {
  draft.title = form.title.value;
  draft.amount = form.amount.value;
  draft.currency = form.currency.value;
  draft.payer = form.payer.value;
  draft.date = form.date.value;
  draft.split.mode = form.mode.value;
  if (draft.split.mode === 'equal') {
    draft.split.among = [...form.querySelectorAll('input[name="among"]:checked')].map(i => i.value);
  } else {
    for (const i of form.querySelectorAll('input[name="share"]')) draft.split.shares[i.dataset.id] = i.value;
  }
}

function fmtIn(cur, v) { return cur === 'TWD' ? ntd(v) : yen(v); }

function renderSplit() {
  const t = S.trip, area = form.querySelector('#splitArea');
  if (draft.split.mode === 'equal') {
    area.innerHTML = `<div class="chips">${t.members.map(m => `<label class="chip"><input type="checkbox" name="among" value="${esc(m.id)}" ${draft.split.among.includes(m.id) ? 'checked' : ''}>${esc(m.name)}</label>`).join('')}</div><p class="hint" id="splitHint"></p>`;
  } else {
    area.innerHTML = t.members.map(m => `<div class="custom-row"><span>${esc(m.name)}</span><input name="share" data-id="${esc(m.id)}" type="number" inputmode="decimal" step="any" min="0" placeholder="0" value="${esc(draft.split.shares[m.id] ?? '')}"></div>`).join('') + '<p class="hint" id="splitHint"></p>';
  }
  updateHint();
}

function updateHint() {
  const hint = form.querySelector('#splitHint');
  const amt = Number(draft.amount) || 0;
  hint.classList.remove('warn');
  if (draft.split.mode === 'equal') {
    const n = draft.split.among.length;
    hint.textContent = n ? `每人約 ${fmtIn(draft.currency, amt / n)}` : '至少選一個人';
    if (!n) hint.classList.add('warn');
  } else {
    const sum = Object.entries(draft.split.shares).filter(([id]) => S.trip.members.some(m => m.id === id)).reduce((s, [, v]) => s + (Number(v) || 0), 0);
    const diff = amt - sum;
    if (Math.abs(diff) < 0.005) hint.textContent = '金額剛好 👍';
    else { hint.textContent = diff > 0 ? `還差 ${fmtIn(draft.currency, diff)} 沒分配` : `多分了 ${fmtIn(draft.currency, -diff)}`; hint.classList.add('warn'); }
  }
}

form.addEventListener('input', e => {
  readDraft();
  if (e.target.name === 'mode') renderSplit(); else updateHint();
});
form.addEventListener('change', e => { if (e.target.name === 'mode' || e.target.name === 'currency') { readDraft(); if (e.target.name === 'mode') renderSplit(); else updateHint(); } });

form.addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'cancel') dlg.close();
  if (act === 'del') {
    if (!confirm(`確定要刪除「${draft.title}」嗎？`)) return;
    try { await store.deleteExpense(S.tripId, editingId); dlg.close(); toast('已刪除'); }
    catch (err) { form.querySelector('#formErr').textContent = '刪除失敗：' + (err.code || err.message); }
  }
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  readDraft();
  const errEl = form.querySelector('#formErr');
  const amt = Number(draft.amount);
  const title = draft.title.trim();
  if (!title) return (errEl.textContent = '寫一下這筆是什麼');
  if (!(amt > 0)) return (errEl.textContent = '金額要大於 0');
  const data = { title, amount: amt, currency: draft.currency, payer: draft.payer, date: draft.date || today() };
  if (draft.split.mode === 'equal') {
    if (!draft.split.among.length) return (errEl.textContent = '至少要選一個人分');
    data.split = { mode: 'equal', among: draft.split.among };
  } else {
    const shares = {};
    let sum = 0;
    for (const m of S.trip.members) { const v = Number(draft.split.shares[m.id]) || 0; if (v > 0) { shares[m.id] = v; sum += v; } }
    if (Math.abs(sum - amt) >= 0.005) return (errEl.textContent = '每個人的金額加起來要等於總金額');
    data.split = { mode: 'custom', shares };
  }
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = '儲存中…';
  try {
    if (editingId) await store.updateExpense(S.tripId, editingId, data);
    else await store.addExpense(S.tripId, data);
    if (!getMe()) ls.set(meKey(), data.payer);
    dlg.close();
    toast(editingId ? '已更新' : '記好了');
  } catch (err) {
    console.error(err);
    errEl.textContent = '儲存失敗：' + (err.code || err.message || '請檢查網路');
    btn.disabled = false; btn.textContent = '儲存';
  }
});

dlg.addEventListener('close', () => { if (S.pending) { S.pending = false; renderTrip(); } });

// ---------- 頁面事件 ----------
app.addEventListener('click', e => {
  const el = e.target.closest('[data-act],[data-tab],[data-exp]');
  if (!el) return;
  if (el.dataset.tab) { S.tab = el.dataset.tab; renderTrip(); return; }
  if (el.dataset.exp) { const x = S.expenses.find(z => z.id === el.dataset.exp); if (x) openExpense(x); return; }
  const act = el.dataset.act;
  if (act === 'add') openExpense(null);
  else if (act === 'share') share();
  else if (act === 'copy') copy(document.getElementById('shareUrl').value);
  else if (act === 'reload') route();
  else if (act === 'add-member-input') { document.getElementById('memberInputs').insertAdjacentHTML('beforeend', memberInput()); document.querySelector('#memberInputs .member-row:last-child input').focus(); }
  else if (act === 'rm-member') { const rows = document.querySelectorAll('#memberInputs .member-row'); if (rows.length > 2) el.closest('.member-row').remove(); else el.closest('.member-row').querySelector('input').value = ''; }
});

app.addEventListener('change', e => {
  if (e.target.id === 'meSel') { ls.set(meKey(), e.target.value); renderTrip(); }
});

app.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'createForm') return createTrip(f);
  if (f.id === 'rateForm') {
    const rate = Number(f.rate.value);
    if (!(rate > 0)) return toast('匯率要大於 0');
    f.rate.blur();
    try { await store.updateTrip(S.tripId, { rate }); toast('匯率已更新'); } catch (err) { toast('更新失敗：' + (err.code || err.message)); }
  }
  if (f.id === 'memberForm') {
    const name = f.name.value.trim();
    if (!name) return;
    if (S.trip.members.some(m => m.name === name)) return toast('已經有這個名字了');
    f.name.value = ''; f.name.blur();
    try { await store.updateTrip(S.tripId, { members: [...S.trip.members, { id: randomId(6), name }] }); toast(`歡迎 ${name} 加入`); }
    catch (err) { toast('新增失敗：' + (err.code || err.message)); }
  }
});

// ---------- 啟動 ----------
(async () => {
  if (configured(firebaseConfig)) {
    try { store = await firebaseStore(); }
    catch (e) { console.error(e); storeError = '雲端資料庫載入失敗，請檢查網路後重新整理。'; }
  } else {
    store = demoStore();
    document.getElementById('demoBanner').hidden = false;
  }
  window.addEventListener('hashchange', route);
  route();
})();
