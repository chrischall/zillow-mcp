import { describe, it, expect } from 'vitest';
import {
  streetAddressVariants,
  swapStreetSuffix,
  compoundTokenVariants,
} from '../../src/tools/resolver.js';

// Issue #76: bidirectional suffix expansion + space-insensitive
// compound-token splits/joins. Real-corpus examples from issue #81.

describe('swapStreetSuffix (bidirectional)', () => {
  it('expands a USPS abbreviated suffix into its long form', () => {
    expect(swapStreetSuffix('268 Mallard Rd')).toBe('268 Mallard Road');
  });

  it('contracts a long suffix into its abbreviated form', () => {
    expect(swapStreetSuffix('12 Eagle Lane')).toBe('12 Eagle Ln');
  });

  it('expands "Hts" -> "Heights" (issue #81: Highland Heights)', () => {
    expect(swapStreetSuffix('181 Highland Hts')).toBe('181 Highland Heights');
  });

  it('contracts "Heights" -> "Hts"', () => {
    expect(swapStreetSuffix('181 Highland Heights')).toBe('181 Highland Hts');
  });

  it('returns null when no recognized suffix sits at the end', () => {
    expect(swapStreetSuffix('255 Gateway')).toBeNull();
  });
});

describe('compoundTokenVariants (space-insensitive)', () => {
  it('splits a single compound token at a known prefix (Bluebird -> Blue Bird)', () => {
    const variants = compoundTokenVariants('231 Bluebird Rd');
    expect(variants).toContain('231 Blue Bird Rd');
  });

  it('joins two adjacent tokens (Blue Bird -> Bluebird)', () => {
    // CONSOLIDATION (realty-mcp#1): now delegates to realty-core's
    // canonical `compoundSplits`. The canonical join lower-cases the
    // second token's leading char (`Bluebird`), where the old local impl
    // preserved it (`BlueBird`). Canonical casing is the contract now.
    const variants = compoundTokenVariants('231 Blue Bird Rd');
    expect(variants).toContain('231 Bluebird Rd');
  });

  it('splits Pinegrove -> Pine Grove', () => {
    const variants = compoundTokenVariants('120 Pinegrove Dr');
    expect(variants).toContain('120 Pine Grove Dr');
  });

  it('does not join across a street suffix ("Cove Rd" stays split)', () => {
    const variants = compoundTokenVariants('99 Cove Rd');
    expect(variants).not.toContain('99 CoveRd');
  });

  it('does not invent joins for non-prefix tokens ("Hidden Cove" stays split)', () => {
    const variants = compoundTokenVariants('142 Hidden Cove Ln');
    expect(variants).not.toContain('142 HiddenCove Ln');
  });
});

describe('streetAddressVariants (combined ladder rung 2)', () => {
  it('includes the original first', () => {
    const variants = streetAddressVariants('268 Mallard Rd');
    expect(variants[0]).toBe('268 Mallard Rd');
  });

  it('produces both Bluebird Rd and Blue Bird Road (compound + suffix combined)', () => {
    // Issue #81: 231 Bluebird Rd ↔ 231 Blue Bird Rd / Road.
    const variants = streetAddressVariants('231 Bluebird Rd');
    expect(variants).toContain('231 Blue Bird Rd');
    expect(variants).toContain('231 Blue Bird Road');
  });

  it('produces Highland Heights variant for Highland Hts input', () => {
    // Issue #81: 181 Highland Hts ↔ 181 Highland Heights.
    const variants = streetAddressVariants('181 Highland Hts');
    expect(variants).toContain('181 Highland Heights');
  });

  it('deduplicates variants while preserving order', () => {
    const variants = streetAddressVariants('268 Mallard Rd');
    expect(new Set(variants).size).toBe(variants.length);
  });
});
