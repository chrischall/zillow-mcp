/**
 * The per-call Zillow request governor shared by the batch tools
 * (`zillow_resolve_addresses`, `zillow_sweep_area`): an RPM token bucket
 * every fetch spends from plus a bot-wall circuit breaker. Lives in its
 * own module so `tools/search.ts` can use it without an import cycle
 * through the resolver.
 */
import type { TokenBucket } from '@chrischall/mcp-utils/fetchproxy';
import { BotWallError, type ZillowClient } from '../client.js';

/**
 * Shared per-call state for {@link governClient}: the RPM bucket every
 * fetch spends a token from, and the first bot-wall seen (a circuit
 * breaker — once PerimeterX walls one fetch, every later fetch in the
 * call fails fast instead of hammering the wall).
 */
export interface ResolveGovernor {
  bucket: TokenBucket;
  wall: BotWallError | null;
}

class ResolveAbandonedError extends Error {
  constructor() {
    super('resolve_addresses overall deadline reached; row abandoned');
    this.name = 'ResolveAbandonedError';
  }
}

/**
 * Wrap `client` so every fetch the 5-rung ladder makes (fleet-audit#288):
 *   - fails fast once the call has hit the bot-wall (re-throwing that
 *     wall, so the row reports `bot_challenge`, never a plain miss);
 *   - spends a token from the per-call RPM bucket before dialling;
 *   - refuses to dial once `signal` is aborted (fleet-audit#289) — the
 *     overall deadline has answered and the row is being discarded, so
 *     the ladder must stop between rungs instead of running on in the
 *     background through the user's browser.
 */
export function governClient(
  client: ZillowClient,
  gov: ResolveGovernor,
  signal?: AbortSignal
): ZillowClient {
  const gate = async (): Promise<void> => {
    if (signal?.aborted) throw new ResolveAbandonedError();
    if (gov.wall) throw gov.wall;
    await gov.bucket.acquire();
    if (signal?.aborted) throw new ResolveAbandonedError();
    if (gov.wall) throw gov.wall;
  };
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    await gate();
    try {
      return await run();
    } catch (e) {
      if (e instanceof BotWallError && !gov.wall) gov.wall = e;
      throw e;
    }
  };
  const governed = Object.create(client) as ZillowClient;
  governed.fetchHtml = (path) => guard(() => client.fetchHtml(path));
  governed.fetchJson = ((path: string, init?: Parameters<ZillowClient['fetchJson']>[1]) =>
    guard(() => client.fetchJson(path, init))) as ZillowClient['fetchJson'];
  return governed;
}
