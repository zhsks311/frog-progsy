/** Anthropic adapter compatibility helpers. FrogProgsy does not own Claude subscription OAuth login. */


// ── Anthropic OAuth-compatible request requirements for explicit custom oauth-mode routes ──
export const ANTHROPIC_OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";
export const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_TOOL_PREFIX = "proxy_";
const ANTHROPIC_BUILTIN_TOOLS = new Set(["web_search", "code_execution", "text_editor", "computer"]);

/** OAuth tokens reject arbitrary tool names; prefix custom tools (Anthropic builtins are exempt). */
export function applyClaudeToolPrefix(name: string): string {
  if (ANTHROPIC_BUILTIN_TOOLS.has(name.toLowerCase()) || name.toLowerCase().startsWith(CLAUDE_TOOL_PREFIX)) return name;
  return CLAUDE_TOOL_PREFIX + name;
}

/** Strip the proxy_ prefix from a returned tool_use name so the caller (Claude Code) sees the original. */
export function stripClaudeToolPrefix(name: string): string {
  return name.startsWith(CLAUDE_TOOL_PREFIX) ? name.slice(CLAUDE_TOOL_PREFIX.length) : name;
}
