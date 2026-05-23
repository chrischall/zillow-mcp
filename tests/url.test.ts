import { describe, it, expect } from 'vitest';
import { urlToPath } from '../src/url.js';

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
