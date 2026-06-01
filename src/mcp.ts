/**
 * Small helpers for shaping tool responses that the MCP SDK expects.
 *
 * The `textResult` wrapper now lives in `@chrischall/mcp-utils` (the
 * single most-duplicated snippet across the fleet). It's re-exported
 * here so the `zillow_*` tools keep importing it from `'../mcp.js'`
 * exactly as before — the indirection is intentional, see CLAUDE.md
 * ("Don't hand-roll the wrapper").
 */
export { textResult } from '@chrischall/mcp-utils';
