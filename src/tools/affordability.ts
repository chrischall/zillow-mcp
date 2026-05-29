import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  calculateAffordability,
  type AffordabilityInput as CoreAffordabilityInput,
  type AffordabilityResult,
} from '@chrischall/realty-core';
import { textResult } from '../mcp.js';

/**
 * Two local-only financial calculators. No network, no Zillow data —
 * just standard mortgage math the user can use against scenarios.
 *
 *   - `zillow_calculate_affordability` — the 28/36 DTI rule. Inverts
 *     PITI to a max home price you can afford given income + debts +
 *     down payment + interest rate.
 *
 *   - `zillow_estimate_rent_vs_buy` — projects costs of owning vs
 *     renting over N years, factoring closing costs, appreciation,
 *     opportunity cost of the down payment, and rent growth. Returns
 *     the break-even year and net cost difference at the horizon.
 *
 * All inputs are validated; outputs are deterministic. Results are
 * informational — they do not replace a lender's pre-approval or
 * an accountant's tax planning.
 *
 * As of the cohort migration (realty-mcp#1) the affordability solver
 * lives canonically in `@chrischall/realty-core` (`calculateAffordability`
 * — same 28/36-DTI inversion, same output shape, same validation
 * messages). `computeAffordability` re-exports it under the local name +
 * input/result types so existing call sites + tests keep working.
 *
 * The rent-vs-buy projection (`computeRentVsBuy`) is KEPT INLINE: zillow's
 * `RentVsBuyResult` carries top-level summary fields
 * (`buy_total_cost_after_sale` / `rent_total_cost` / `net_difference` /
 * `buy_wins`), a default horizon of 7 (not 10), and per-year
 * `cumulative_buy_cost` figures that are GROSS cash outflow — whereas
 * realty-core's `estimateRentVsBuy` exposes a `{ inputs, years,
 * break_even_year }` superset whose per-year `cumulative_buy_cost` is the
 * NET-if-sold figure. Projecting the canonical result back to this tool's
 * output would be a lossy adapter that changes the
 * `zillow_estimate_rent_vs_buy` contract, so we keep zillow's model.
 */

// ---- Affordability ---------------------------------------------------

// Re-export the canonical input/result types under the local names so
// existing imports (`from './affordability'`) keep working. The shape is
// identical to zillow's old inline definitions.
export type AffordabilityInput = CoreAffordabilityInput;
export type { AffordabilityResult };

/**
 * Solve for the max home price under the 28/36 DTI rule.
 * The binding constraint is whichever cap (front-end OR back-end)
 * limits the monthly PITI more tightly.
 *
 * Thin re-export of realty-core's `calculateAffordability` — same math,
 * same `{ max_home_price, max_monthly_piti, binding_constraint, ... }`
 * output, same validation error messages.
 */
export function computeAffordability(
  input: AffordabilityInput
): AffordabilityResult {
  return calculateAffordability(input);
}

// ---- Rent vs buy -----------------------------------------------------

export interface RentVsBuyInput {
  home_price: number;
  down_payment: number;
  interest_rate: number; // annual %
  loan_term_years?: number;
  property_tax_rate?: number; // annual % of home value
  insurance_annual?: number;
  hoa_monthly?: number;
  maintenance_rate?: number; // annual % of home value, default 1%
  closing_cost_rate?: number; // % of home price, default 2.5%
  selling_cost_rate?: number; // % of sale price, default 6%
  /** Annual home-price appreciation, %. Default 3.0 */
  appreciation_rate?: number;
  /** Comparable monthly rent. Required. */
  monthly_rent: number;
  /** Annual rent growth, %. Default 3.0 */
  rent_growth_rate?: number;
  /** Annual return on the down-payment-as-invested. Default 6.0 */
  investment_return_rate?: number;
  /** Horizon in years. Default 7 */
  horizon_years?: number;
}

export interface RentVsBuyResult {
  horizon_years: number;
  buy_total_cost_after_sale: number;
  rent_total_cost: number;
  net_difference: number;
  buy_wins: boolean;
  break_even_year: number | null;
  yearly: Array<{
    year: number;
    cumulative_buy_cost: number;
    cumulative_rent_cost: number;
    home_value: number;
    remaining_mortgage: number;
    equity_if_sold_now: number;
  }>;
}

/**
 * Roughed-up rent-vs-buy model. Compares cumulative cash outlay over
 * `horizon_years` between renting and buying, treating buying's "cost"
 * as actual cash outflow (down payment + PITI + maintenance + closing)
 * net of equity recovered if you sold at year N (subtracting selling
 * costs).
 *
 * The opportunity-cost of the down payment is modeled via the rent
 * side: the renter's downpayment-equivalent is assumed invested at
 * `investment_return_rate`, and the *return* on that investment offsets
 * rent costs. That's the standard way of making the comparison fair.
 */
export function computeRentVsBuy(input: RentVsBuyInput): RentVsBuyResult {
  if (input.home_price <= 0) throw new Error('home_price must be positive');
  if (input.monthly_rent <= 0)
    throw new Error('monthly_rent must be positive');
  const horizon = input.horizon_years ?? 7;
  if (horizon <= 0) throw new Error('horizon_years must be positive');

  const term_years = input.loan_term_years ?? 30;
  const r = input.interest_rate / 100 / 12;
  const n = term_years * 12;
  const loan = Math.max(0, input.home_price - input.down_payment);
  const monthly_pi =
    r === 0 ? loan / n : loan * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);

  const closing = input.home_price * ((input.closing_cost_rate ?? 2.5) / 100);
  const selling_rate = (input.selling_cost_rate ?? 6) / 100;
  const tax_rate = (input.property_tax_rate ?? 1.1) / 100;
  const insurance = input.insurance_annual ?? 0;
  const hoa = (input.hoa_monthly ?? 0) * 12;
  const maint_rate = (input.maintenance_rate ?? 1) / 100;
  const appreciation = (input.appreciation_rate ?? 3) / 100;
  const rent_growth = (input.rent_growth_rate ?? 3) / 100;
  const invest_return = (input.investment_return_rate ?? 6) / 100;

  let cum_buy = input.down_payment + closing;
  let cum_rent = 0;
  let invested = input.down_payment; // renter's parallel investment
  let home_value = input.home_price;
  let principal_remaining = loan;
  const yearly: RentVsBuyResult['yearly'] = [];
  let break_even: number | null = null;
  let final_net_after_sale = 0;

  for (let y = 1; y <= horizon; y++) {
    // 12 months of payments
    const year_pi = monthly_pi * 12;
    const year_tax = home_value * tax_rate;
    const year_maint = home_value * maint_rate;
    cum_buy += year_pi + year_tax + insurance + hoa + year_maint;

    // Pay down principal: compute interest portion + principal portion
    let interest_paid = 0;
    let principal_paid = 0;
    for (let m = 0; m < 12; m++) {
      const int_m = principal_remaining * r;
      const pi_m = Math.min(monthly_pi, principal_remaining + int_m);
      const prin_m = pi_m - int_m;
      principal_remaining = Math.max(0, principal_remaining - prin_m);
      interest_paid += int_m;
      principal_paid += prin_m;
    }

    // Rent + grow rent
    const year_rent = input.monthly_rent * 12 * Math.pow(1 + rent_growth, y - 1);
    cum_rent += year_rent;
    // Renter's invested down payment grows
    invested = invested * (1 + invest_return);

    // Home appreciates
    home_value = home_value * (1 + appreciation);

    // Equity if we sold this year: sale_price - selling_costs - mortgage_balance
    const sale_proceeds = home_value * (1 - selling_rate) - principal_remaining;
    const buy_net_if_sold = cum_buy - sale_proceeds;
    // Compare with cum_rent net of investment growth (renter's net cost)
    const renter_invest_growth = invested - input.down_payment;
    const rent_net = cum_rent - renter_invest_growth;
    if (break_even === null && buy_net_if_sold <= rent_net) break_even = y;

    yearly.push({
      year: y,
      cumulative_buy_cost: round2(cum_buy),
      cumulative_rent_cost: round2(cum_rent),
      home_value: round2(home_value),
      remaining_mortgage: round2(principal_remaining),
      equity_if_sold_now: round2(home_value * (1 - selling_rate) - principal_remaining),
    });
    if (y === horizon) final_net_after_sale = buy_net_if_sold - rent_net;
  }

  return {
    horizon_years: horizon,
    buy_total_cost_after_sale: round2(
      cum_buy - (home_value * (1 - selling_rate) - principal_remaining)
    ),
    rent_total_cost: round2(cum_rent - (invested - input.down_payment)),
    net_difference: round2(final_net_after_sale),
    buy_wins: final_net_after_sale < 0,
    break_even_year: break_even,
    yearly,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---- Registration ----------------------------------------------------

export function registerAffordabilityTools(server: McpServer): void {
  server.registerTool(
    'zillow_calculate_affordability',
    {
      title: 'Calculate max affordable home price',
      description:
        "Solve for the maximum home price you can afford under the standard 28/36 DTI rule. Inputs: monthly income, monthly recurring debts (car loans, student loans, etc.), down payment, interest rate, and optional property-tax rate / insurance / HOA / loan term. Output: max home price, the binding constraint (front-end vs back-end), and the full PITI breakdown at that price. No network — pure local math.",
      annotations: {
        title: 'Calculate max affordable home price',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        monthly_income: z.number().positive(),
        monthly_debts: z
          .number()
          .nonnegative()
          .optional()
          .describe('Sum of monthly debt payments (car, student loans, etc.)'),
        down_payment: z.number().nonnegative(),
        interest_rate: z.number().nonnegative().describe('Annual %, e.g. 6.5'),
        loan_term_years: z.number().int().positive().optional().describe('Default 30'),
        property_tax_rate: z.number().nonnegative().optional().describe('Annual % of home price, default 1.1'),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        front_end_dti: z
          .number()
          .positive()
          .max(1)
          .optional()
          .describe('Front-end DTI cap as decimal, default 0.28'),
        back_end_dti: z
          .number()
          .positive()
          .max(1)
          .optional()
          .describe('Back-end DTI cap as decimal, default 0.36'),
      },
    },
    async (input) => textResult(computeAffordability(input as AffordabilityInput))
  );

  server.registerTool(
    'zillow_estimate_rent_vs_buy',
    {
      title: 'Estimate rent-vs-buy break-even over a horizon',
      description:
        "Project the cumulative cost of buying a home versus renting a comparable place over N years. Accounts for down payment, closing costs, monthly PITI, maintenance (~1%/yr default), property appreciation (~3%/yr default), rent growth (~3%/yr default), and the opportunity cost of the down payment (renter invests it at the investment_return_rate, default 6%/yr). Returns the year-by-year cumulative costs, the break-even year, and the net difference at the horizon. No network — pure local math.",
      annotations: {
        title: 'Estimate rent-vs-buy break-even over a horizon',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        home_price: z.number().positive(),
        down_payment: z.number().nonnegative(),
        interest_rate: z.number().nonnegative(),
        loan_term_years: z.number().int().positive().optional(),
        property_tax_rate: z.number().nonnegative().optional(),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        maintenance_rate: z.number().nonnegative().optional().describe('Annual % of home value, default 1.0'),
        closing_cost_rate: z.number().nonnegative().optional().describe('% of home price, default 2.5'),
        selling_cost_rate: z.number().nonnegative().optional().describe('% of sale price, default 6.0'),
        appreciation_rate: z.number().optional().describe('Annual %, default 3.0'),
        monthly_rent: z.number().positive(),
        rent_growth_rate: z.number().optional().describe('Annual %, default 3.0'),
        investment_return_rate: z
          .number()
          .optional()
          .describe('Annual return on the renter\'s parallel-invested down payment, default 6.0'),
        horizon_years: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Default 7'),
      },
    },
    async (input) => textResult(computeRentVsBuy(input as RentVsBuyInput))
  );
}
