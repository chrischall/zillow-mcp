// Invariant: .claude-plugin/plugin.json declares its MCP config under the
// `mcpServers` key Claude Code actually reads. The key `mcp` is unknown to
// Claude Code (`claude plugin validate` warns "Unknown field 'mcp'") and is
// silently ignored at load time — it only appeared to work here because
// ./.mcp.json is the default location anyway.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(
  readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
) as Record<string, unknown>;

describe('plugin.json packaging', () => {
  it('declares its MCP config under `mcpServers`, not the ignored `mcp` key', () => {
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin).toHaveProperty('mcpServers');
  });

  it('points `mcpServers` at a file that exists', () => {
    const ref = plugin.mcpServers;
    expect(typeof ref).toBe('string');
    expect(existsSync(join(ROOT, ref as string))).toBe(true);
  });
});
