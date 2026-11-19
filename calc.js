// 分帳計算：全部換成「日圓整數」來算，避免小數誤差。
// trip.rate = 1 日圓等於多少台幣（例如 0.21）

export function toJPY(amount, currency, rate) {
  return currency === 'TWD' ? amount / rate : amount;
}

// 一筆帳每個人要負擔多少（日圓整數）
export function expenseShares(e, members, rate) {
  const total = Math.round(toJPY(Number(e.amount) || 0, e.currency, rate));
  const out = {};
  const order = members.map(m => m.id);

  if (e.split && e.split.mode === 'custom') {
    const shares = e.split.shares || {};
    const ids = order.filter(id => Number(shares[id]) > 0);
    let sum = 0;
    for (const id of ids) {
      const v = Math.round(toJPY(Number(shares[id]), e.currency, rate));
      out[id] = v;
      sum += v;
    }
    // 換匯四捨五入差的那一點點，算給第一個人
    if (ids.length && sum !== total) out[ids[0]] += total - sum;
    return out;
  }

  const among = order.filter(id => (e.split?.among || []).includes(id));
  if (!among.length) return out;
  const base = Math.floor(total / among.length);
  let rest = total - base * among.length;
  for (const id of among) {
    out[id] = base + (rest > 0 ? 1 : 0);
    if (rest > 0) rest--;
  }
  return out;
}

// 每個人：付了多少、該負擔多少、淨額（正 = 別人要還他）
export function balances(trip, expenses) {
  const res = {};
  for (const m of trip.members) res[m.id] = { paid: 0, owed: 0, net: 0 };
  for (const e of expenses) {
    const total = Math.round(toJPY(Number(e.amount) || 0, e.currency, trip.rate));
    if (res[e.payer]) res[e.payer].paid += total;
    const sh = expenseShares(e, trip.members, trip.rate);
    for (const [id, v] of Object.entries(sh)) if (res[id]) res[id].owed += v;
  }
  for (const id in res) res[id].net = res[id].paid - res[id].owed;
  return res;
}

// 最後誰給誰多少：欠最多的先還給被欠最多的，轉帳次數會很少
export function settle(bal) {
  const cred = [], debt = [];
  for (const [id, b] of Object.entries(bal)) {
    if (b.net > 0) cred.push({ id, amt: b.net });
    else if (b.net < 0) debt.push({ id, amt: -b.net });
  }
  cred.sort((a, b) => b.amt - a.amt);
  debt.sort((a, b) => b.amt - a.amt);
  const tx = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i].amt, cred[j].amt);
    if (x > 0) tx.push({ from: debt[i].id, to: cred[j].id, amount: x });
    debt[i].amt -= x;
    cred[j].amt -= x;
    if (debt[i].amt === 0) i++;
    if (cred[j].amt === 0) j++;
  }
  return tx;
}
