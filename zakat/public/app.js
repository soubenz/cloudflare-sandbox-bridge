import { GROUPS, calculate } from './calc.js';

const KEY = 'zakat-state-v1';
const DEFAULT = {
  rates: { EUR: 1, GBP: 1.15, USD: 0.86, DZD: 0.0066 },
  groups: {}, debts: [], goldPricePerGram: '',
};
let state = structuredClone(DEFAULT);
try { state = { ...state, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

function itemList(items, onChange, rerender) {
  const wrap = document.createElement('div');
  items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<input class="label" placeholder="Label"><input class="amount" type="number" inputmode="decimal" placeholder="0"><select></select><button class="x" title="Remove">×</button>`;
    const [label, amount, cur, rm] = row.children;
    label.value = item.label || '';
    amount.value = item.amount ?? '';
    for (const c of Object.keys(state.rates)) cur.add(new Option(c, c, false, c === (item.currency || 'EUR')));
    label.oninput = () => { item.label = label.value; onChange(); };
    amount.oninput = () => { item.amount = amount.value; onChange(); };
    cur.onchange = () => { item.currency = cur.value; onChange(); };
    rm.onclick = () => { items.splice(i, 1); onChange(); rerender(); };
    wrap.append(row);
  });
  const add = document.createElement('button');
  add.className = 'add'; add.textContent = '+ Add';
  add.onclick = () => { items.push({ label: '', amount: '', currency: 'EUR' }); onChange(); rerender(); };
  wrap.append(add);
  return wrap;
}

function render() {
  $('rates').innerHTML = '';
  for (const c of Object.keys(state.rates)) {
    const l = document.createElement('label');
    l.textContent = c;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = 'any'; inp.value = state.rates[c]; inp.disabled = c === 'EUR';
    inp.oninput = () => { state.rates[c] = Number(inp.value); update(); };
    l.append(inp); $('rates').append(l);
  }

  $('groups').innerHTML = '';
  for (const g of GROUPS) {
    const items = (state.groups[g.key] ||= []);
    const sec = document.createElement('section');
    const pct = g.factor === 1 ? '' : g.factor === 0 ? 'no zakat' : `${g.factor * 100}% counts`;
    sec.innerHTML = `<h2>${g.label} <small>${pct}</small></h2><p class="hint">${g.hint}</p>`;
    sec.append(itemList(items, update, render));
    $('groups').append(sec);
  }

  $('debts').innerHTML = '';
  $('debts').append(itemList(state.debts, update, render));
  $('gold').value = state.goldPricePerGram;
  update();
}

function update() {
  save();
  const r = calculate(state);
  $('due').textContent = fmt(r.zakat);
  $('base').textContent = fmt(r.base);
  const rows = GROUPS.map((g) => [g.label, r.totals[g.key]]);
  rows.push(['Debts', -r.debtTotal], ['Cash-like net of debts', r.netCashLike], ['Stocks (40%)', r.stocksZakatable]);
  $('breakdown').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${fmt(v)}</td></tr>`).join('');
  $('note').textContent = r.nisab > 0
    ? (r.belowNisab ? `Below nisab (${fmt(r.nisab)}): no zakat due.` : `Above nisab (${fmt(r.nisab)}).`)
    : '';
}

$('gold').oninput = () => { state.goldPricePerGram = $('gold').value; update(); };
render();
