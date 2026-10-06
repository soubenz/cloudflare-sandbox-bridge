// Pure zakat logic, no DOM. Rules come from the "Zakat" page in Notion:
//  - cash, gold/silver, company cash, receivables (Godwin, Qardus/Kapitalboost,
//    yielders): zakatable in full at 2.5%
//  - stocks / equity ETFs: 40% of the value is zakatable (= 1% overall)
//  - sukuk, property and REIT funds: not zakatable
//  - debts are deducted from the cash-like assets
export const ZAKAT_RATE = 0.025;
export const STOCK_FACTOR = 0.4;

// key, label, factor (share of the value that is zakatable), hint
export const GROUPS = [
  { key: 'cash', label: 'Cash', factor: 1, hint: 'Bank accounts, broker cash, wallets, cash in hand, company cash.' },
  { key: 'metals', label: 'Gold & silver', factor: 1, hint: 'Market value today.' },
  { key: 'qardus', label: 'Qardus / Kapitalboost', factor: 1, hint: 'Outstanding balance owed to you: capital + profit due.' },
  { key: 'godwin', label: 'Godwin Capital', factor: 1, hint: 'Current value of the investment.' },
  { key: 'yielders', label: 'Yielders: rental income', factor: 1, hint: 'Rental income received while the property is not yet sold.' },
  { key: 'yielders_sale', label: 'Yielders: sale year', factor: 1, hint: 'Only in the year it is sold: value of your share + profit (it becomes stock).' },
  { key: 'stocks', label: 'Stocks / equity ETFs', factor: STOCK_FACTOR, hint: 'Trading 212, Degiro, Lightyear... Only 40% counts. No REITs.' },
  { key: 'exempt', label: 'Sukuk, property & REIT funds', factor: 0, hint: 'Listed for completeness, no zakat due.' },
];

export const DEBT_KEY = 'debts';
const CASH_LIKE = ['cash', 'metals', 'qardus', 'godwin', 'yielders', 'yielders_sale'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// rates: how many EUR one unit of the currency is worth, e.g. { EUR: 1, GBP: 1.16 }
export function toBase(item, rates) {
  const rate = rates[item.currency] ?? 1;
  return num(item.amount) * num(rate);
}

export function sum(items = [], rates) {
  return items.reduce((s, i) => s + toBase(i, rates), 0);
}

// state: { rates, groups: { [key]: items[] }, debts: items[] }
export function calculate(state) {
  const { rates, groups = {}, debts = [] } = state;
  const totals = {};
  for (const g of GROUPS) totals[g.key] = sum(groups[g.key], rates);

  const cashLike = CASH_LIKE.reduce((s, k) => s + totals[k], 0);
  const debtTotal = sum(debts, rates);
  const netCashLike = Math.max(0, cashLike - debtTotal);
  const stocksZakatable = totals.stocks * STOCK_FACTOR;
  const base = netCashLike + stocksZakatable;

  const zakat = base * ZAKAT_RATE;

  return { totals, cashLike, debtTotal, netCashLike, stocksZakatable, base, zakat };
}
