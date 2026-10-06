import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module served as a static asset
import { calculate } from '../../zakat/public/calc.js';

const rates = { EUR: 1, GBP: 1.2 };

describe('zakat calculate', () => {
  it('cash minus debts at 2.5%', () => {
    const r = calculate({ rates, groups: { cash: [{ amount: 1000, currency: 'EUR' }] }, debts: [{ amount: 200, currency: 'EUR' }] });
    expect(r.base).toBe(800);
    expect(r.zakat).toBeCloseTo(20);
  });
  it('stocks count at 40%, so 1% overall', () => {
    const r = calculate({ rates, groups: { stocks: [{ amount: 10000, currency: 'EUR' }] } });
    expect(r.zakat).toBeCloseTo(100);
  });
  it('sukuk/property funds are exempt', () => {
    expect(calculate({ rates, groups: { exempt: [{ amount: 5000, currency: 'EUR' }] } }).zakat).toBe(0);
  });
  it('converts currencies', () => {
    expect(calculate({ rates, groups: { qardus: [{ amount: 1000, currency: 'GBP' }] } }).base).toBe(1200);
  });
  it('debts never push cash-like below zero or eat into stocks', () => {
    const r = calculate({ rates, groups: { cash: [{ amount: 100, currency: 'EUR' }], stocks: [{ amount: 1000, currency: 'EUR' }] }, debts: [{ amount: 500, currency: 'EUR' }] });
    expect(r.base).toBe(400);
  });
});
