// Opt-in frame-drop visibility. The streaming path is intentionally quiet (no unconditional
// console output), so this no-ops unless FROGP_DEBUG_FRAMES=1. Lets a malformed/chunk-split
// upstream frame be detected instead of silently truncating content.
const DEBUG_FRAMES = process.env.FROGP_DEBUG_FRAMES === "1";

export function debugDroppedFrame(adapter: string, payload: string): void {
  if (!DEBUG_FRAMES) return;
  const preview = payload.length > 200 ? `${payload.slice(0, 200)}…` : payload;
  console.error(`[frogp:frame-drop] ${adapter}: ${preview}`);
}
