// fleet-audit#916: ZILLOW_WS_PORT used to go through a bare Number(), so
// 'abc' became NaN and the banner echoed the raw value. resolveWsPort
// validates it (integer 1..65535), warns on stderr when it is set but
// unusable, and reports the effective port the bridge will bind.
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_WS_PORT, resolveWsPort } from '../src/ws-port.js';

describe('resolveWsPort', () => {
  it('defaults to 37149 with no warning when ZILLOW_WS_PORT is unset', () => {
    const warn = vi.fn();
    expect(resolveWsPort({}, warn)).toEqual({ port: undefined, effectivePort: 37149 });
    expect(DEFAULT_WS_PORT).toBe(37149);
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats an empty / whitespace value as unset, without warning', () => {
    const warn = vi.fn();
    expect(resolveWsPort({ ZILLOW_WS_PORT: '  ' }, warn).port).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a valid port (surrounding whitespace trimmed)', () => {
    const warn = vi.fn();
    expect(resolveWsPort({ ZILLOW_WS_PORT: ' 40000 ' }, warn)).toEqual({
      port: 40000,
      effectivePort: 40000,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '65536', '-1', '3.5', '1e4'])(
    'falls back to the default and warns on stderr for %j',
    (raw) => {
      const warn = vi.fn();
      expect(resolveWsPort({ ZILLOW_WS_PORT: raw }, warn)).toEqual({
        port: undefined,
        effectivePort: 37149,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain('ZILLOW_WS_PORT');
      expect(msg).toContain('1-65535');
      expect(msg).toContain('37149');
    }
  );

  it('accepts the bounds 1 and 65535', () => {
    expect(resolveWsPort({ ZILLOW_WS_PORT: '1' }, vi.fn()).port).toBe(1);
    expect(resolveWsPort({ ZILLOW_WS_PORT: '65535' }, vi.fn()).port).toBe(65535);
  });

  it('defaults to process.env and console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prev = process.env.ZILLOW_WS_PORT;
    process.env.ZILLOW_WS_PORT = 'nope';
    try {
      expect(resolveWsPort().effectivePort).toBe(37149);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.ZILLOW_WS_PORT;
      else process.env.ZILLOW_WS_PORT = prev;
      spy.mockRestore();
    }
  });
});
