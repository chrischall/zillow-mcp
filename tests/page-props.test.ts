import { describe, it, expect } from 'vitest';
import { findArrayByShape } from '../src/page-props.js';

describe('findArrayByShape', () => {
  it('returns the first direct-key match', () => {
    const result = findArrayByShape<{ id: number }>(
      { savedSearches: [{ id: 1 }], userSavedSearches: [{ id: 99 }] },
      ['savedSearches', 'userSavedSearches'],
      () => true
    );
    expect(result).toEqual([{ id: 1 }]);
  });

  it('falls through to the second key when the first is absent', () => {
    const result = findArrayByShape<{ id: number }>(
      { userSavedSearches: [{ id: 2 }] },
      ['savedSearches', 'userSavedSearches'],
      () => true
    );
    expect(result).toEqual([{ id: 2 }]);
  });

  it('falls through to the shape predicate when no direct key matches', () => {
    const result = findArrayByShape<{ filterState: object }>(
      { somethingElse: [{ filterState: { x: 1 } }] },
      ['savedSearches'],
      (el) => 'filterState' in el
    );
    expect(result).toEqual([{ filterState: { x: 1 } }]);
  });

  it('skips arrays whose first element fails the predicate', () => {
    const result = findArrayByShape<unknown>(
      { wrong: [{ foo: 1 }], right: [{ filterState: {} }] },
      [],
      (el) => 'filterState' in el
    );
    expect(result).toEqual([{ filterState: {} }]);
  });

  it('skips empty arrays in the shape walk', () => {
    const result = findArrayByShape<unknown>(
      { empty: [], good: [{ filterState: {} }] },
      [],
      (el) => 'filterState' in el
    );
    expect(result).toEqual([{ filterState: {} }]);
  });

  it('skips arrays of non-objects', () => {
    const result = findArrayByShape<unknown>(
      { strings: ['a', 'b'], good: [{ filterState: {} }] },
      [],
      (el) => 'filterState' in el
    );
    expect(result).toEqual([{ filterState: {} }]);
  });

  it('returns [] when nothing matches', () => {
    expect(
      findArrayByShape<unknown>({ foo: 'bar' }, ['x'], () => true)
    ).toEqual([]);
  });

  it('ignores a direct-key value that is not an array', () => {
    const result = findArrayByShape<{ id: number }>(
      { savedSearches: 'oops', userSavedSearches: [{ id: 7 }] },
      ['savedSearches', 'userSavedSearches'],
      () => true
    );
    expect(result).toEqual([{ id: 7 }]);
  });
});
