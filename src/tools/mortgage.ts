import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  calculateMortgage,
  type MortgageInput as CoreMortgageInput,
} from '@chrischall/realty-core';
import { textResult } from '../mcp.js';

/**
 * Local-only mortgage payment calculator. Parity with sap156/zillow-mcp-
 * server's `calculate_mortgage`. No network — entirely deterministic so
 * the model can reason about scenarios without burning a fetch.
 *
 * Computes the canonical PITI breakdown:
 *   P&I        — principal + interest via the amortization formula
 *   Taxes      — property tax (annual / 12)
 *   Insurance  — homeowner's insurance (annual / 12)
 *   HOA        — monthly HOA dues
 *   PMI        — when LTV > 80% and pmi_rate provided
 *
 * As of the cohort migration (realty-mcp#1) the PITI math lives
 * canonically in `@chrischall/realty-core` (`calculateMortgage`) — the
 * canonical shape was modelled on zillow's, so it's the same formula and
 * the same field values. `computeMortgage` is now a thin adapter: it
 * delegates to the core and projects the result back to zillow's exact
 * output contract (the core carries one extra echoed `home_price` field
 * that zillow's shape doesn't expose, dropped here).
 */

export interface MortgageInput {
  home_price: number;
  down_payment?: number;
  down_payment_percent?: number;
  interest_rate: number; // annual %, e.g. 6.5
  loan_term_years?: number;
  property_tax_annual?: number;
  property_tax_rate?: number; // % of home_price annually, alternative to property_tax_annual
  insurance_annual?: number;
  hoa_monthly?: number;
  pmi_rate?: number; // annual % of loan balance
}

export interface MortgageBreakdown {
  loan_amount: number;
  down_payment: number;
  monthly_principal_interest: number;
  monthly_property_tax: number;
  monthly_insurance: number;
  monthly_hoa: number;
  monthly_pmi: number;
  monthly_total: number;
  total_interest_paid: number;
  total_paid_over_loan: number;
  loan_term_years: number;
  interest_rate: number;
  ltv_percent: number;
}

export function computeMortgage(input: MortgageInput): MortgageBreakdown {
  // Delegate to realty-core's canonical PITI calculator (same math,
  // same validation, same field values — modelled on zillow's), then
  // drop the extra echoed `home_price` to preserve zillow's output shape.
  const { home_price: _home_price, ...rest } = calculateMortgage(
    input as CoreMortgageInput
  );
  return rest;
}

export function registerMortgageTools(server: McpServer): void {
  server.registerTool(
    'zillow_calculate_mortgage',
    {
      title: 'Calculate mortgage payment (local)',
      description:
        'Local-only mortgage payment calculator. Returns a full PITI breakdown (principal + interest, property tax, insurance, HOA, PMI) and total interest over the life of the loan. No network call — fully deterministic, safe to use for scenario comparison without burning a fetch. Provide either down_payment OR down_payment_percent; defaults to 20%. Property tax can be given as property_tax_annual or property_tax_rate (% of home price). PMI applies automatically when LTV > 80% and pmi_rate is provided.',
      annotations: {
        title: 'Calculate mortgage payment (local)',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        home_price: z.number().positive(),
        down_payment: z.number().nonnegative().optional(),
        down_payment_percent: z.number().nonnegative().max(100).optional(),
        interest_rate: z.number().nonnegative().describe('Annual %, e.g. 6.5'),
        loan_term_years: z.number().int().positive().optional().describe('Default 30'),
        property_tax_annual: z.number().nonnegative().optional(),
        property_tax_rate: z.number().nonnegative().optional().describe('Annual % of home price'),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        pmi_rate: z.number().nonnegative().optional().describe('Annual %, applied when LTV > 80%'),
      },
    },
    async (input) => textResult(computeMortgage(input as MortgageInput))
  );
}
