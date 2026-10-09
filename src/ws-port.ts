// Resolve the localhost WebSocket port the fetchproxy bridge binds.
//
// ZILLOW_WS_PORT is read through mcp-utils' hardened `readIntEnv` (trimmed;
// blank / 'undefined' / 'null' / unsubstituted `${...}` placeholders count as
// unset; junk, non-integers and out-of-range values yield undefined), so a
// typo can no longer reach the transport as NaN (fleet-audit#916). A value
// that is set but unusable is reported on stderr — stdout belongs to the
// stdio JSON-RPC stream — and the bridge falls back to the default port.
import { readEnvVar, readIntEnv, type EnvSource } from '@chrischall/mcp-utils';

/** The fleet-standard fetchproxy bridge port. */
export const DEFAULT_WS_PORT = 37_149;

const ENV_KEY = 'ZILLOW_WS_PORT';

export interface ResolvedWsPort {
  /** The validated override, or undefined when unset/invalid. */
  port: number | undefined;
  /** The port the bridge will actually listen on. */
  effectivePort: number;
}

export function resolveWsPort(
  env: EnvSource = process.env,
  warn: (message: string) => void = (m) => console.error(m)
): ResolvedWsPort {
  const port = readIntEnv(ENV_KEY, { env, min: 1, max: 65_535 });
  if (port === undefined && readEnvVar(ENV_KEY, { env }) !== undefined) {
    warn(
      `[zillow-mcp] Ignoring ${ENV_KEY}: expected an integer port in 1-65535; ` +
        `using the default ${DEFAULT_WS_PORT}.`
    );
  }
  return { port, effectivePort: port ?? DEFAULT_WS_PORT };
}
