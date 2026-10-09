import { describe, it, expect } from 'vitest';
import { isPathUnder, urlToPath } from '../src/url.js';

describe('urlToPath', () => {
  it('strips the origin from an absolute Zillow URL', () => {
    expect(
      urlToPath('https://www.zillow.com/homedetails/foo/7_zpid/')
    ).toBe('/homedetails/foo/7_zpid/');
  });

  it('preserves the query string', () => {
    expect(urlToPath('https://www.zillow.com/x?a=1&b=2')).toBe('/x?a=1&b=2');
  });

  it('passes through a path that already starts with /', () => {
    expect(urlToPath('/already/path/')).toBe('/already/path/');
  });

  it('prepends / to a bare path segment', () => {
    expect(urlToPath('homedetails/7_zpid/')).toBe('/homedetails/7_zpid/');
  });

  it('handles URLs with hash fragments by dropping them', () => {
    // `hash` is intentionally left out — Zillow's server doesn't see it
    // anyway. Behavior choice: prefer path+search clean.
    expect(urlToPath('https://www.zillow.com/x#frag')).toBe('/x');
  });
});

describe('isPathUnder', () => {
  it('accepts a plain path under the prefix', () => {
    expect(isPathUnder('/homedetails/1_zpid/?a=1', '/homedetails/')).toBe(true);
  });

  it('rejects backslash and %5c separators', () => {
    expect(
      isPathUnder('/homedetails/1_zpid/\\..\\..\\myzillow/', '/homedetails/')
    ).toBe(false);
    expect(isPathUnder('/homedetails/x%5Cy/', '/homedetails/')).toBe(false);
  });

  // The URL parser strips tab/newline, so `.\t.` becomes `..` in the
  // browser even though no literal segment equals `..`.
  it('rejects a path that the URL parser normalises out of the prefix', () => {
    expect(
      isPathUnder('/homedetails/.\t./myzillow/SavedSearches', '/homedetails/')
    ).toBe(false);
  });
});
