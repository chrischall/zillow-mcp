import { describe, it, expect } from 'vitest';
import { seriesAvailabilityNote } from '../../src/tools/series-note.js';

describe('seriesAvailabilityNote', () => {
  it('returns undefined when the series is non-empty (no note needed)', () => {
    expect(
      seriesAvailabilityNote({ empty: false, sourcePresent: true, kind: 'price history' })
    ).toBeUndefined();
    expect(
      seriesAvailabilityNote({ empty: false, sourcePresent: false, kind: 'price history' })
    ).toBeUndefined();
  });

  it('flags an SSR-omission when the source field was ABSENT (lean listing shape)', () => {
    const note = seriesAvailabilityNote({
      empty: true,
      sourcePresent: false,
      kind: 'Zestimate history',
    });
    expect(note).toBeDefined();
    expect(note).toMatch(/server-rendered/i);
    expect(note).toMatch(/Zestimate history/);
    // Must NOT claim the property genuinely has none.
    expect(note).not.toMatch(/no Zestimate history on record/i);
  });

  it('reports a genuine empty when the source field was PRESENT but empty', () => {
    const note = seriesAvailabilityNote({
      empty: true,
      sourcePresent: true,
      kind: 'tax history',
    });
    expect(note).toMatch(/no tax history on record/i);
    expect(note).not.toMatch(/server-rendered/i);
  });
});
