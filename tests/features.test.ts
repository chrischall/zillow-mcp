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
    it('does NOT false-positive to "finished" via a free-floating preposition (canonical detector)', () => {
      // Behavior delta from adopting realty-core's canonical detector:
      // the tight BASEMENT_CONNECTOR class only bridges "basement" to a
      // state word across is/was/are/were/punctuation — NOT prepositions
      // like "with". The old looser `[^.!?]{0,30}?` window crossed "with"
      // and mis-tagged "basement with finished oak shelving" as
      // 'finished' (the shelving is finished, not the basement). It now
      // correctly resolves to 'unknown'.
      expect(
        extractFeatures('Basement with finished oak shelving', baseCommunities).basement
      ).toBe('unknown');
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
    it('does NOT misfire on bare "with exceptions" in non-furnishing context (false-positive pin)', () => {
      // Real-estate prose routinely uses "with exceptions" in title /
      // survey / HOA / disclosure contexts unrelated to furnishings.
      // The `furnished` token must anchor the partial match. Mirrors
      // the fix landed in onehome-mcp PR #28 commit bada4e5.
      expect(
        extractFeatures(
          'Sold with exceptions per title report; modern open floor plan.',
          baseCommunities
        ).furnished
      ).toBeNull();
      expect(
        extractFeatures(
          'HOA documents available with exceptions noted in section 3.',
          baseCommunities
        ).furnished
      ).toBeNull();
    });
    it('still matches "furnished with exceptions" when anchored', () => {
      // The anchored form should keep working — only the bare
      // alternative was removed. (Carefully avoid words like "sold
      // furnished" or "fully furnished" that would trip the FULLY
      // detector ahead of PARTIAL.)
      expect(
        extractFeatures('Comes furnished with exceptions noted', baseCommunities).furnished
      ).toBe('partial');
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
    // CANONICAL DELTA (realty-mcp#1, realty-core 0.4.0): the marina detector
    // now guards against place-names — "Marina Bay" / "Marina del Rey" /
    // "Marina Dr" are addresses/neighborhoods, NOT a real marina amenity, so
    // they no longer false-positive to `dock: 'marina'`. Genuine marina
    // language (a marina with boat access / steps from the marina) still maps.
    it('does NOT treat the place-name "Marina Bay" as a marina amenity', () => {
      expect(extractFeatures('Marina Bay', baseCommunities).dock).toBeNull();
    });
    it('does NOT treat the place-name "Marina del Rey" as a marina amenity', () => {
      expect(extractFeatures('Marina del Rey', baseCommunities).dock).toBeNull();
    });
    it('does NOT treat a "Marina Dr" street name as a marina amenity', () => {
      expect(extractFeatures('123 Marina Dr', baseCommunities).dock).toBeNull();
    });
    it('still matches a genuine marina-with-boat-access description', () => {
      expect(
        extractFeatures('Beautiful home in marina with boat access', baseCommunities).dock
      ).toBe('marina');
    });
    it('still matches "Steps from the marina."', () => {
      expect(extractFeatures('Steps from the marina.', baseCommunities).dock).toBe('marina');
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

  describe('negative cache (issue #61 polish nit)', () => {
    // The failure paths (missing file / malformed JSON / wrong shape)
    // used to re-stat the filesystem on every call. For high-volume tool
    // use that's wasteful — the negative result is keyed on the env-var
    // path and reused until the path changes.
    //
    // Tested behaviorally: prime the negative cache against a missing /
    // malformed file, then change the file's contents on disk WITHOUT
    // changing the env-var path. If the cache is honoured, the
    // post-mutation result should still be the fallback; otherwise the
    // loader will have re-read the disk and seen the new content.

    it('caches the missing-file fallback until the env-var path changes', () => {
      const p = join(tmp, 'missing.json');
      process.env.ZILLOW_COMMUNITIES_FILE = p;

      // Prime: file is missing → fallback.
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

      // Materialise a valid file at the SAME path. Without a negative
      // cache the loader would now read and return the new contents;
      // with the negative cache it keeps returning the fallback.
      writeFileSync(p, '["NewlyAppeared"]');
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    });

    it('caches the malformed-JSON fallback until the env-var path changes', () => {
      const p = join(tmp, 'bad.json');
      writeFileSync(p, '{not json');
      process.env.ZILLOW_COMMUNITIES_FILE = p;

      // Prime: bad JSON → fallback.
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

      // Repair the file in-place. Without a negative cache the loader
      // would now read + parse + return ['Recovered']; with the cache
      // it keeps returning the fallback.
      writeFileSync(p, '["Recovered"]');
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    });

    it('caches the wrong-shape fallback until the env-var path changes', () => {
      const p = join(tmp, 'wrong-shape.json');
      writeFileSync(p, '{"a": 1}');
      process.env.ZILLOW_COMMUNITIES_FILE = p;

      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

      writeFileSync(p, '["NowRight"]');
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    });

    it('invalidates negative cache when env-var path changes', () => {
      // Path A is missing → cached negative.
      process.env.ZILLOW_COMMUNITIES_FILE = join(tmp, 'first-missing.json');
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

      // Path B is valid → cache must NOT serve the stale negative.
      const p = join(tmp, 'now-valid.json');
      writeFileSync(p, '["Alpha", "Beta"]');
      process.env.ZILLOW_COMMUNITIES_FILE = p;
      expect(loadCommunities()).toEqual(['Alpha', 'Beta']);
    });

    it('clears negative cache when env-var becomes unset', () => {
      process.env.ZILLOW_COMMUNITIES_FILE = join(tmp, 'gone.json');
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

      delete process.env.ZILLOW_COMMUNITIES_FILE;
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);

      // Re-setting to a valid path should still work (not stale-cached).
      const p = join(tmp, 'fresh.json');
      writeFileSync(p, '["Gamma"]');
      process.env.ZILLOW_COMMUNITIES_FILE = p;
      expect(loadCommunities()).toEqual(['Gamma']);
    });
  });
});
