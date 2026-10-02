import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  calculateMortgage,
  registerMortgageTool,
  type MortgageInput as CoreMortgageInput,
} from '@chrischall/realty-core';
import { minifiedResult } from '@chrischall/mcp-utils';

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
  // Schema, description and canonical output are realty-core's shared
  // registrar (fleet-audit#1090). `shape: 'canonical'` adds the echoed
  // `home_price` to zillow's previous output (additive only) and caps
  // `loan_term_years` at MAX_LOAN_TERM_YEARS.
  registerMortgageTool(server, {
    z,
    prefix: 'zillow',
    shape: 'canonical',
    toResult: minifiedResult,
  });
}
