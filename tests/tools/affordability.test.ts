import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  computeAffordability,
  computeRentVsBuy,
  registerAffordabilityTools,
} from '../../src/tools/affordability.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

describe('computeAffordability', () => {
  it('respects the 28% front-end constraint when it binds', () => {
    // High debts → back-end would be looser; front-end binds.
    const r = computeAffordability({
      monthly_income: 10_000,
      monthly_debts: 0,
      down_payment: 100_000,
      interest_rate: 6.5,
      property_tax_rate: 1.0,
      insurance_annual: 1200,
    });
    expect(r.binding_constraint).toBe('front_end');
    expect(r.max_monthly_piti).toBe(2800); // 10k * 0.28
    expect(r.max_home_price).toBeGreaterThan(100_000);
  });

  it('respects the 36% back-end constraint when debts are heavy', () => {
    // $2k/mo of other debts means back-end allowance is 3.6k - 2k = 1.6k,
    // which is tighter than the front-end 2.8k. Back-end binds.
    const r = computeAffordability({
      monthly_income: 10_000,
      monthly_debts: 2000,
      down_payment: 100_000,
      interest_rate: 6.5,
    });
    expect(r.binding_constraint).toBe('back_end');
    expect(r.max_monthly_piti).toBe(1600);
  });

  it('scales max_home_price with down_payment monotonically', () => {
    const base = {
      monthly_income: 8_000,
      interest_rate: 6,
      property_tax_rate: 1.0,
    };
    const a = computeAffordability({ ...base, down_payment: 50_000 });
    const b = computeAffordability({ ...base, down_payment: 200_000 });
    expect(b.max_home_price).toBeGreaterThan(a.max_home_price);
  });

  it('rejects non-positive income', () => {
    expect(() =>
      computeAffordability({
        monthly_income: 0,
        down_payment: 100,
        interest_rate: 5,
      })
    ).toThrow(/monthly_income/);
  });

  it('handles 0% interest rate', () => {
    const r = computeAffordability({
      monthly_income: 5000,
      down_payment: 100_000,
      interest_rate: 0,
      loan_term_years: 30,
    });
    expect(r.max_home_price).toBeGreaterThan(100_000);
    expect(r.monthly_principal_interest).toBeGreaterThan(0);
  });
});

describe('computeRentVsBuy', () => {
  it('returns a year-by-year series of the requested length', () => {
    const r = computeRentVsBuy({
      home_price: 600_000,
      down_payment: 120_000,
      interest_rate: 6.5,
      monthly_rent: 3000,
      horizon_years: 10,
    });
    expect(r.yearly).toHaveLength(10);
    expect(r.horizon_years).toBe(10);
  });

  it('finds a break-even year when buying eventually wins', () => {
    // Modest rent, low appreciation flag → buying should beat renting within 30 years
    const r = computeRentVsBuy({
      home_price: 500_000,
      down_payment: 100_000,
      interest_rate: 5,
      monthly_rent: 2800,
      horizon_years: 30,
      appreciation_rate: 3.5,
      rent_growth_rate: 3.5,
    });
    expect(r.break_even_year).not.toBeNull();
    expect(r.break_even_year!).toBeGreaterThan(0);
    expect(r.break_even_year!).toBeLessThanOrEqual(30);
  });

  it('returns null break-even when renting always wins', () => {
    // Cheap rent + tiny appreciation → buying never catches up
    const r = computeRentVsBuy({
      home_price: 1_000_000,
      down_payment: 200_000,
      interest_rate: 7.5,
      monthly_rent: 1500,
      horizon_years: 5,
      appreciation_rate: 0,
      rent_growth_rate: 0,
    });
    expect(r.break_even_year).toBeNull();
    expect(r.buy_wins).toBe(false);
  });

  it('cumulative_buy_cost is monotonically non-decreasing', () => {
    const r = computeRentVsBuy({
      home_price: 500_000,
      down_payment: 100_000,
      interest_rate: 6,
      monthly_rent: 2500,
      horizon_years: 15,
    });
    for (let i = 1; i < r.yearly.length; i++) {
      expect(r.yearly[i].cumulative_buy_cost).toBeGreaterThanOrEqual(
        r.yearly[i - 1].cumulative_buy_cost
      );
    }
  });

  it('rejects invalid inputs', () => {
    expect(() =>
      computeRentVsBuy({
        home_price: 0,
        down_payment: 0,
        interest_rate: 5,
        monthly_rent: 1500,
      })
    ).toThrow(/home_price/);
    expect(() =>
      computeRentVsBuy({
        home_price: 100_000,
        down_payment: 0,
        interest_rate: 5,
        monthly_rent: 0,
      })
    ).toThrow(/monthly_rent/);
  });

  it('stops charging P&I once the loan is paid off (horizon > loan term)', () => {
    // fleet-audit #968: years past the term kept adding monthly_pi * 12.
    const base = {
      home_price: 400_000,
      down_payment: 80_000,
      interest_rate: 6.5,
      monthly_rent: 2500,
      loan_term_years: 15,
    };
    const r = computeRentVsBuy({ ...base, horizon_years: 20 });
    const loan = 320_000;
    const mr = 0.065 / 12;
    const n = 15 * 12;
    const annualPi = ((loan * mr * Math.pow(1 + mr, n)) / (Math.pow(1 + mr, n) - 1)) * 12;
    expect(r.yearly[14].remaining_mortgage).toBe(0);
    const delta = (i: number) =>
      r.yearly[i].cumulative_buy_cost - r.yearly[i - 1].cumulative_buy_cost;
    // Year 16 outflow is only tax + insurance + HOA + maintenance: it must
    // drop by (roughly) the annual P&I versus year 15, not keep growing.
    expect(delta(14) - delta(15)).toBeGreaterThan(annualPi * 0.9);
    // Year 16+ deltas carry no P&I at all: tax (1.1%) + maint (1%) of value.
    for (let i = 15; i < 20; i++) {
      const prevValue = r.yearly[i - 1].home_value;
      expect(delta(i)).toBeCloseTo(prevValue * 0.021, 0);
    }
  });

  it('total P&I paid over the full term equals the amortised payments', () => {
    const r = computeRentVsBuy({
      home_price: 300_000,
      down_payment: 60_000,
      interest_rate: 0,
      monthly_rent: 2000,
      loan_term_years: 10,
      horizon_years: 12,
      property_tax_rate: 0,
      maintenance_rate: 0,
      closing_cost_rate: 0,
    });
    // 0% interest: cash outflow is exactly the down payment + the loan.
    expect(r.yearly[9].cumulative_buy_cost).toBeCloseTo(300_000, 2);
    expect(r.yearly[11].cumulative_buy_cost).toBeCloseTo(300_000, 2);
  });

  it('rejects unbounded horizons / terms and a down payment above price', () => {
    const base = { home_price: 300_000, down_payment: 60_000, interest_rate: 6, monthly_rent: 2000 };
    expect(() => computeRentVsBuy({ ...base, horizon_years: 51 })).toThrow(/horizon_years/);
    expect(() => computeRentVsBuy({ ...base, loan_term_years: 51 })).toThrow(/loan_term_years/);
    expect(() => computeRentVsBuy({ ...base, down_payment: 300_001 })).toThrow(/down_payment/);
  });
});

describe('affordability tools — MCP integration', () => {
  let h: Awaited<ReturnType<typeof createTestHarness>>;
  beforeAll(async () => {
    h = await createTestHarness((server) => registerAffordabilityTools(server));
  });
  afterAll(async () => {
    await h.close();
  });

  it('zillow_calculate_affordability returns a max price + PITI breakdown', async () => {
    const r = await h.callTool('zillow_calculate_affordability', {
      monthly_income: 12_000,
      down_payment: 150_000,
      interest_rate: 6.5,
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      max_home_price: number;
      max_monthly_piti: number;
      binding_constraint: string;
    }>(r);
    expect(parsed.max_home_price).toBeGreaterThan(0);
    expect(parsed.max_monthly_piti).toBe(3360); // 12000 * 0.28
  });

  it('zillow_estimate_rent_vs_buy returns horizon + yearly series', async () => {
    const r = await h.callTool('zillow_estimate_rent_vs_buy', {
      home_price: 600_000,
      down_payment: 120_000,
      interest_rate: 6.5,
      monthly_rent: 3000,
      horizon_years: 7,
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      horizon_years: number;
      yearly: unknown[];
    }>(r);
    expect(parsed.horizon_years).toBe(7);
    expect(parsed.yearly).toHaveLength(7);
  });

  it('zillow_estimate_rent_vs_buy rejects horizon_years above the cap', async () => {
    const r = await h.callTool('zillow_estimate_rent_vs_buy', {
      home_price: 600_000,
      down_payment: 120_000,
      interest_rate: 6.5,
      monthly_rent: 3000,
      horizon_years: 51,
    });
    expect(r.isError).toBe(true);
  });
});
