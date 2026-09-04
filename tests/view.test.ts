import { describe, it, expect } from 'vitest';
import { ZW_VIEWS, viewArg, viewResponse } from '../src/view.js';

/**
 * Unit coverage for `src/view.ts` — the `view` rung this server answers in.
 *
 * PR #224 shipped this module and its wiring with no tests at all (#225), so
 * the two claims its docblock makes were unenforced: that compact is
 * SUBTRACTIVE and therefore cannot lose a field nobody knew about, and that
 * the constructed `image_url` is kept in spite of the blind media rule. Both
 * are exactly the kind of property that a later "tidy-up" breaks silently —
 * the response still parses, it is just missing something.
 */

/** The serialized body of a tool result, which is what a caller actually receives. */
function bodyOf(result: ReturnType<typeof viewResponse>): string {
  return (result.content[0] as { text: string }).text;
}

function parseBody<T>(result: ReturnType<typeof viewResponse>): T {
  return JSON.parse(bodyOf(result)) as T;
}

describe('ZW_VIEWS / viewArg', () => {
  it('honours compact and full only — never raw', () => {
    // `raw` means "the upstream payload, unprojected", and this server
    // assembles nothing: compact is already a passthrough minus media, so a
    // third rung would silently alias to `full`. A schema must not advertise
    // a value that does nothing.
    expect(ZW_VIEWS).toEqual(['compact', 'full']);
    expect(viewArg().safeParse('raw').success).toBe(false);
  });

  it('accepts both honoured rungs and is optional', () => {
    // Optional because compact is the DEFAULT — an efficiency a caller has to
    // ask for is one that is usually not asked for.
    expect(viewArg().safeParse('compact').success).toBe(true);
    expect(viewArg().safeParse('full').success).toBe(true);
    expect(viewArg().safeParse(undefined).success).toBe(true);
  });

  it("names what this server's compact does and does not do", () => {
    // The generic blurb says a projection happened; only the tool can say
    // that this one strips media and performs NO field projection, which is
    // the difference between "some fields were dropped" and "no field you
    // asked for was dropped".
    const description = viewArg().description ?? '';
    expect(description).toMatch(/strips image\/avatar URLs/i);
    expect(description).toMatch(/no field projection/i);
  });
});

describe('viewResponse', () => {
  it('defaults to compact when no view is given', () => {
    // The inversion that is the whole point of the fleet convention: an
    // absent `view` is the CHEAP answer, not the expensive one.
    const data = { name: 'x', photo: 'https://cdn/a.jpg' };
    expect(parseBody<Record<string, unknown>>(viewResponse(undefined, data))).toEqual({
      name: 'x',
    });
  });

  it('returns the payload untouched on full', () => {
    // `full` is the escape hatch a caller reaches for when compact took
    // something they needed — so it must return the media too, byte for byte.
    const data = { name: 'x', photo: 'https://cdn/a.jpg' };
    expect(parseBody<Record<string, unknown>>(viewResponse('full', data))).toEqual(data);
  });

  it('keeps the constructed image_url on compact (#119)', () => {
    // The grounded exception to the blind rule. `search.ts` derives
    // `image_url` deliberately — off `imgSrc` for a real search hit, off
    // `photos`/`responsivePhotos` for an adapted homedetails hit — so that a
    // single-address result carries an image like a real one. Its VALUE ends
    // in `.jpg`, so the media rule would take it on sight; only the `keep`
    // entry saves it. A sibling media key with no such grounding still goes.
    const listing = {
      zpid: '2061813066',
      image_url: 'https://photos.zillowstatic.com/fp/first.jpg',
      thumbnail: 'https://photos.zillowstatic.com/fp/thumb.jpg',
      url: 'https://www.zillow.com/homedetails/2061813066_zpid/',
    };
    const compact = parseBody<Record<string, unknown>>(viewResponse('compact', listing));
    expect(compact.image_url).toBe('https://photos.zillowstatic.com/fp/first.jpg');
    expect(compact).not.toHaveProperty('thumbnail');
    // The homedetails link is a PAGE, not a picture. Losing it would cost the
    // caller the one field they need to go look at the listing.
    expect(compact.url).toBe('https://www.zillow.com/homedetails/2061813066_zpid/');
  });

  it('leaves a field nobody anticipated alone on compact', () => {
    // The honesty claim in view.ts's docblock: this repo holds no verified
    // record of Zillow's payload, so compact does the one projection that
    // needs no such knowledge. Being SUBTRACTIVE-BY-MEDIA-ONLY is what makes
    // that safe — an invented field list would hand back a record with holes
    // in it that still reads like a verified answer.
    const data = { zpid: '1', somethingNobodyAnticipated: { nested: [1, 2, 3] } };
    expect(parseBody<Record<string, unknown>>(viewResponse('compact', data))).toEqual(data);
  });

  it('preserves whitespace INSIDE a value byte for byte, on both rungs', () => {
    // Minification drops FORMATTING whitespace only. A listing description's
    // blank lines between paragraphs are content — the paragraph breaks ARE
    // the structure of the text — and a hand-rolled minifier (a regex over
    // the serialized string, a `\s+` collapse) corrupts exactly the large
    // payloads minification exists to shrink.
    const description =
      'Charming lake cottage.\n\nUpdated kitchen, new roof.\n\n  - Dock included\n  - Mountain views\n';
    for (const view of ['compact', 'full'] as const) {
      const parsed = parseBody<{ description: string }>(
        viewResponse(view, { zpid: '1', description })
      );
      expect(parsed.description).toBe(description);
    }
  });

  it('serializes to a single line', () => {
    // `JSON.stringify(data, null, 2)` spends roughly a fifth of a large
    // response on indentation nothing downstream reads. The newlines inside
    // the description above survive as the two-character escape `\n`, so a
    // body carrying multi-paragraph prose is still exactly one physical line
    // — which is why this assertion and the one above do not conflict.
    const body = bodyOf(
      viewResponse('compact', { zpid: '1', description: 'a\n\nb', nested: { k: [1, 2] } })
    );
    expect(body.split('\n')).toHaveLength(1);
    expect(body).toContain('a\\n\\nb');
  });

  it('falls back to compact for a rung this server does not honour', () => {
    // Second line of defense behind the schema. It fails toward the CHEAP
    // answer rather than throwing: a caller that somehow named an
    // unavailable rung is better served by a small correct response than by
    // an error.
    const data = { name: 'x', photo: 'https://cdn/a.jpg' };
    expect(parseBody<Record<string, unknown>>(viewResponse('raw', data))).toEqual({
      name: 'x',
    });
  });

  it('does not mutate the payload it was handed', () => {
    // Tools hand this live objects assembled upstream; stripping in place
    // would empty the caller's own copy as a side effect of formatting it.
    const data = { zpid: '1', photo: 'https://cdn/a.jpg' };
    viewResponse('compact', data);
    expect(data.photo).toBe('https://cdn/a.jpg');
  });
});
