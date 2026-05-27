import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COMMUNITIES,
  extractFeatures,
  loadCommunities,
} from '../src/features.js';

describe('extractFeatures', () => {
  const baseCommunities = DEFAULT_COMMUNITIES;

  it('returns all-null/false defaults when description is undefined', () => {
    const out = extractFeatures(undefined, baseCommunities);
    expect(out).toEqual({
      lake_front: false,
      hot_tub: false,
      basement: null,
      furnished: null,
      dock: null,
      community: null,
    });
  });

  it('returns defaults when description is the empty string', () => {
    const out = extractFeatures('', baseCommunities);
    expect(out.lake_front).toBe(false);
    expect(out.basement).toBeNull();
  });

  describe('lake_front', () => {
    it('matches lakefront (one word)', () => {
      expect(extractFeatures('Lakefront paradise', baseCommunities).lake_front).toBe(true);
    });
    it('matches lake front (two words)', () => {
      expect(extractFeatures('Has lake front views', baseCommunities).lake_front).toBe(true);
    });
    it('matches waterfront', () => {
      expect(extractFeatures('Waterfront cottage', baseCommunities).lake_front).toBe(true);
    });
    it('is case-insensitive', () => {
      expect(extractFeatures('LAKEFRONT', baseCommunities).lake_front).toBe(true);
    });
    it('does not match unrelated tokens (lakeside, oceanfront)', () => {
      expect(extractFeatures('lakeside dock', baseCommunities).lake_front).toBe(false);
      expect(extractFeatures('oceanfront property', baseCommunities).lake_front).toBe(false);
    });
  });

  describe('hot_tub', () => {
    it('matches hot tub (with space)', () => {
      expect(extractFeatures('Includes a hot tub', baseCommunities).hot_tub).toBe(true);
    });
    it('does not match hottub or jacuzzi', () => {
      expect(extractFeatures('Has a hottub', baseCommunities).hot_tub).toBe(false);
      expect(extractFeatures('jacuzzi on deck', baseCommunities).hot_tub).toBe(false);
    });
  });

  describe('basement', () => {
    it('returns "unfinished" — checked BEFORE "finished" (substring trap)', () => {
      // The regression test that pins the substring-trap bug:
      // "finished" matches inside "unfinished". Run the unfinished
      // detector first.
      expect(extractFeatures('Has an unfinished basement', baseCommunities).basement).toBe('unfinished');
    });
    it('returns "unfinished" with the words reversed (basement, unfinished)', () => {
      expect(
        extractFeatures('The basement is unfinished currently', baseCommunities).basement
      ).toBe('unfinished');
    });
    it('returns "unfinished" even in a sentence that ALSO contains "finished"', () => {
      // E.g. "finished hardwood floors throughout, basement is unfinished".
      // The full-text scan would match `finished` first if the regex
      // ordering was wrong.
      expect(
        extractFeatures(
          'Finished hardwood floors throughout. The basement is unfinished.',
          baseCommunities
        ).basement
      ).toBe('unfinished');
    });
    it('returns "finished" when only "finished basement" appears', () => {
      expect(extractFeatures('Bonus room and finished basement', baseCommunities).basement).toBe('finished');
    });
    it('returns "partial" for partial / partially finished basement', () => {
      expect(extractFeatures('Has a partially finished basement', baseCommunities).basement).toBe('partial');
      expect(extractFeatures('Partial basement', baseCommunities).basement).toBe('partial');
    });
    it('returns "unknown" when "basement" is mentioned without qualifier', () => {
      expect(extractFeatures('Includes a basement', baseCommunities).basement).toBe('unknown');
    });
    it('returns null when no basement language is present', () => {
      expect(extractFeatures('Three bedroom home', baseCommunities).basement).toBeNull();
    });
  });

  describe('furnished', () => {
    it('matches "fully furnished"', () => {
      expect(extractFeatures('Fully furnished', baseCommunities).furnished).toBe('fully');
    });
    it('matches "sold furnished"', () => {
      expect(extractFeatures('Sold furnished', baseCommunities).furnished).toBe('fully');
    });
    it('matches "turnkey"', () => {
      expect(extractFeatures('Move-in ready turnkey home', baseCommunities).furnished).toBe('fully');
    });
    it('matches partial', () => {
      expect(
        extractFeatures('Almost furnished, owner taking artwork', baseCommunities).furnished
      ).toBe('partial');
    });
    it('matches negotiable', () => {
      expect(
        extractFeatures('Furnishings are negotiable', baseCommunities).furnished
      ).toBe('negotiable');
    });
    it('returns null otherwise', () => {
      expect(extractFeatures('Lovely home', baseCommunities).furnished).toBeNull();
    });
  });

  describe('dock', () => {
    it('prefers "private" over "community"', () => {
      // Specificity ordering pin: private > community > boat_slip > marina.
      expect(
        extractFeatures(
          'Has a private dock and access to community dock too',
          baseCommunities
        ).dock
      ).toBe('private');
    });
    it('matches "private dock"', () => {
      expect(extractFeatures('Private dock for boats', baseCommunities).dock).toBe('private');
    });
    it('matches "community dock"', () => {
      expect(extractFeatures('Has community dock access', baseCommunities).dock).toBe('community');
    });
    it('matches "boat slip"', () => {
      expect(extractFeatures('Includes a boat slip', baseCommunities).dock).toBe('boat_slip');
    });
    it('matches "boatslip" (one word)', () => {
      expect(extractFeatures('Boatslip included', baseCommunities).dock).toBe('boat_slip');
    });
    it('matches "marina" as the most general option', () => {
      expect(extractFeatures('Walk to the marina', baseCommunities).dock).toBe('marina');
    });
    it('returns null when no dock language is present', () => {
      expect(extractFeatures('Mountain views', baseCommunities).dock).toBeNull();
    });
  });

  describe('community', () => {
    it('matches a community name case-insensitively', () => {
      expect(
        extractFeatures('Located in rumbling bald gated community', DEFAULT_COMMUNITIES).community
      ).toBe('Rumbling Bald');
    });
    it('tolerates trailing punctuation', () => {
      expect(
        extractFeatures('Rumbling Bald.', DEFAULT_COMMUNITIES).community
      ).toBe('Rumbling Bald');
    });
    it('returns the EARLIEST match in document order (not vocabulary order)', () => {
      // Riverbend appears second in DEFAULT_COMMUNITIES but FIRST in the
      // text — it should win.
      expect(
        extractFeatures(
          'Riverbend at Lake Lure community. Also see Rumbling Bald nearby.',
          DEFAULT_COMMUNITIES
        ).community
      ).toBe('Riverbend at Lake Lure');
    });
    it('returns null when no community is named', () => {
      expect(extractFeatures('Lovely cabin', DEFAULT_COMMUNITIES).community).toBeNull();
    });
    it('returns null when communities vocabulary is empty', () => {
      expect(extractFeatures('Rumbling Bald', []).community).toBeNull();
    });
  });
});

describe('loadCommunities', () => {
  let tmp: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'zillow-communities-'));
    prevEnv = process.env.ZILLOW_COMMUNITIES_FILE;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.ZILLOW_COMMUNITIES_FILE;
    else process.env.ZILLOW_COMMUNITIES_FILE = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns DEFAULT_COMMUNITIES when env var is unset', () => {
    delete process.env.ZILLOW_COMMUNITIES_FILE;
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
  });

  it('returns DEFAULT_COMMUNITIES when the env var points at a missing file', () => {
    process.env.ZILLOW_COMMUNITIES_FILE = join(tmp, 'missing.json');
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
  });

  it('returns DEFAULT_COMMUNITIES when the file contains malformed JSON', () => {
    const p = join(tmp, 'bad.json');
    writeFileSync(p, '{not json');
    process.env.ZILLOW_COMMUNITIES_FILE = p;
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
  });

  it('returns DEFAULT_COMMUNITIES when JSON is not a string array', () => {
    const p = join(tmp, 'wrong-shape.json');
    writeFileSync(p, '{"a": 1}');
    process.env.ZILLOW_COMMUNITIES_FILE = p;
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
  });

  it('returns the parsed list when the file is a valid JSON string array', () => {
    const p = join(tmp, 'custom.json');
    writeFileSync(p, '["Foo Hills", "Bar Estates"]');
    process.env.ZILLOW_COMMUNITIES_FILE = p;
    expect(loadCommunities()).toEqual(['Foo Hills', 'Bar Estates']);
  });
});
