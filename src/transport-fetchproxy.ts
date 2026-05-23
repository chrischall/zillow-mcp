// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// zillow-mcp's ZillowTransport interface.
//
// FetchproxyServer is domain-agnostic — its FetchInit shape is
// `{ url, method, tabUrl, headers?, body? }`. zillow-mcp's tools and
// ZillowClient use zillow-relative paths (`/homedetails/...`,
// `/async-create-search-page-state/`), so the adapter prepends
// `https://www.zillow.com` and pins `tabUrl` to zillow.com so the
// extension routes the fetch through the right tab.
import { FetchproxyServer, type FetchproxyServerOpts } from '@fetchproxy/server';
import type { FetchInit, FetchResult, ZillowTransport } from './transport.js';

const ZILLOW_ORIGIN = 'https://www.zillow.com';
const ZILLOW_TAB_URL = 'https://www.zillow.com/';

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'zillow-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
}

export class FetchproxyTransport implements ZillowTransport {
  private readonly inner: FetchproxyServer;

  constructor(opts: FetchproxyTransportOptions) {
    const options: FetchproxyServerOpts = {
      port: opts.port ?? 37149,
      serverName: opts.server ?? 'zillow-mcp',
      version: opts.version,
      // Subdomains of zillow.com (www, photos, etc.) match automatically.
      domains: ['zillow.com'],
    };
    this.inner = new FetchproxyServer(options);
  }

  start(): Promise<void> {
    return this.inner.listen();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const url = init.path.startsWith('http')
      ? init.path
      : `${ZILLOW_ORIGIN}${init.path}`;
    const result = await this.inner.fetch({
      url,
      method: init.method,
      tabUrl: ZILLOW_TAB_URL,
      headers: init.headers,
      body: init.body,
    });
    // fetchproxy returns a discriminated union. ZillowTransport's
    // contract is "return on HTTP-level outcomes (including 4xx/5xx),
    // throw on protocol-level failures". Map ok:false to a thrown error.
    if (!result.ok) {
      throw new Error(`fetchproxy transport error: ${result.error}`);
    }
    return { status: result.status, body: result.body, url: result.url };
  }
}
