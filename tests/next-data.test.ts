import { describe, it, expect } from 'vitest';
import { extractNextData, getPageProps, ParseError } from '../src/next-data.js';

describe('extractNextData', () => {
  it('extracts JSON from a __NEXT_DATA__ script tag', () => {
    const html =
      '<html><body>blah</body>' +
      '<script id="__NEXT_DATA__" type="application/json">' +
      '{"props":{"pageProps":{"foo":"bar"}}}' +
      '</script></html>';
    const data = extractNextData(html);
    expect(data).toEqual({ props: { pageProps: { foo: 'bar' } } });
  });

  it('tolerates extra attributes on the script tag', () => {
    const html =
      '<script data-test="1" id="__NEXT_DATA__" data-build="abc" type="application/json">' +
      '{"a":1}</script>';
    expect(extractNextData(html)).toEqual({ a: 1 });
  });

  it('handles single-quoted id', () => {
    const html =
      `<script id='__NEXT_DATA__' type='application/json'>{"a":1}</script>`;
    expect(extractNextData(html)).toEqual({ a: 1 });
  });

  it('throws ParseError when the script tag is missing', () => {
    expect(() => extractNextData('<html>nope</html>')).toThrow(ParseError);
  });

  it('throws ParseError when the closing </script> is missing', () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">{"a":1}';
    expect(() => extractNextData(html)).toThrow(ParseError);
  });

  it('throws ParseError on invalid JSON inside the tag', () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">{not json}</script>';
    expect(() => extractNextData(html)).toThrow(ParseError);
  });
});

describe('getPageProps', () => {
  it('returns props.pageProps when present', () => {
    expect(
      getPageProps({ props: { pageProps: { x: 1 } } })
    ).toEqual({ x: 1 });
  });

  it('returns {} when pageProps is missing', () => {
    expect(getPageProps({ props: {} })).toEqual({});
    expect(getPageProps({})).toEqual({});
  });
});
