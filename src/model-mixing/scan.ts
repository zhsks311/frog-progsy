import type { AdapterEvent } from "../types";

/**
 * Split a non-streaming turn's adapter events into the events to forward and whether a real tool
 * call was present. Unlike `scanEventsForWebSearch` (web-search-fallback/loop.ts), model-mixing has
 * no synthetic tool to intercept — every event is forwarded in order; this only detects whether a
 * tool_call_start..tool_call_end sequence occurred, for callers that branch on it (e.g. the pipeline
 * Verifier-as-review gate).
 */
export function scanEventsForMix(events: AdapterEvent[]): {
  forwarded: AdapterEvent[];
  hasRealToolCall: boolean;
} {
  let hasRealToolCall = false;
  for (const e of events) {
    if (e.type === "tool_call_start") hasRealToolCall = true;
  }
  return { forwarded: [...events], hasRealToolCall };
}
