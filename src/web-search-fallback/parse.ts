/** A single web source backing the fallback's answer. */
export interface WebSearchSource {
  url: string;
  title?: string;
}

/** The fallback's synthesized answer plus its sources (empty `sources` is fine). */
export interface WebSearchResult {
  text: string;
  sources: WebSearchSource[];
  /** Set only when the stream surfaced an error AND produced no usable answer text. */
  error?: string;
}

interface AnnotationLike {
  type?: string;
  url?: string;
  title?: string;
}
interface OutputTextBlock {
  type?: string;
  text?: string;
  annotations?: AnnotationLike[];
}
interface OutputItem {
  type?: string;
  content?: OutputTextBlock[];
}

/** Push a `url_citation` annotation as a source, de-duplicated by URL. */
function collectAnnotation(ann: AnnotationLike | undefined, sources: WebSearchSource[], seen: Set<string>): void {
  if (!ann || ann.type !== "url_citation" || typeof ann.url !== "string" || seen.has(ann.url)) return;
  seen.add(ann.url);
  sources.push({ url: ann.url, ...(ann.title ? { title: ann.title } : {}) });
}

/** Pull final text + url_citation sources from a completed Responses `output[]` array. */
function fromOutputArray(output: OutputItem[], seen: Set<string>): WebSearchResult {
  let text = "";
  const sources: WebSearchSource[] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block.type === "output_text" && typeof block.text === "string") {
        text += block.text;
        for (const ann of block.annotations ?? []) collectAnnotation(ann, sources, seen);
      }
    }
  }
  return { text, sources };
}

/**
 * Parse the fallback's streamed Responses SSE into a final answer + sources. Tolerant of the full set of
 * Responses streaming events: prefers the authoritative `response.completed` output[], then the
 * `response.output_text.done` text; falls back to accumulated `response.output_text.delta`. Sources are
 * collected from EVERY shape they arrive in — `response.output_text.annotation.added` events (the
 * streaming path, which earlier testing missed → empty citations), `done`-block `annotations[]`, and
 * the final output[]. `response.failed`/`error` events surface as `error` when no answer text was produced.
 */
export async function parseFallbackSSE(response: Response): Promise<WebSearchResult> {
  if (!response.body) return { text: "", sources: [] };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen = new Set<string>();
  // Holder object — fields are mutated inside the closure, so they can't live as narrowed locals.
  const acc: {
    deltaText: string;
    doneText: string;
    final: WebSearchResult | null;
    streamSources: WebSearchSource[];
    error: string | null;
  } = { deltaText: "", doneText: "", final: null, streamSources: [], error: null };

  const handle = (payload: string): void => {
    if (!payload || payload === "[DONE]") return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(payload) as Record<string, unknown>; } catch { return; }
    const type = data.type as string | undefined;
    if (type === "response.output_text.delta" && typeof data.delta === "string") {
      acc.deltaText += data.delta;
    } else if (type === "response.output_text.done" && typeof data.text === "string") {
      // The `done` event carries the full, authoritative text for one content part.
      acc.doneText += data.text;
    } else if (type === "response.completed" || type === "response.done") {
      const resp = data.response as { output?: OutputItem[] } | undefined;
      if (resp?.output) acc.final = fromOutputArray(resp.output, seen);
    } else if (type === "response.failed" || type === "response.incomplete" || type === "error") {
      const resp = data.response as { error?: { message?: string } } | undefined;
      const msg = resp?.error?.message
        ?? (data.error as { message?: string } | undefined)?.message
        ?? (typeof data.message === "string" ? data.message : undefined);
      if (msg) acc.error = msg;
    }
    // Citations stream as a dedicated `response.output_text.annotation.added` event (singular
    // `annotation`); capture it regardless of the exact event name so they aren't lost.
    if (data.annotation) collectAnnotation(data.annotation as AnnotationLike, acc.streamSources, seen);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) handle(line.slice(6).trim());
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Prefer the authoritative completed output[], then the done text, then accumulated deltas.
  const text = (acc.final?.text.trim() ? acc.final.text : "")
    || acc.doneText.trim() && acc.doneText
    || acc.deltaText;
  // Merge sources from the final output[] and the streaming annotation events.
  const sources = [...(acc.final?.sources ?? [])];
  const seenMerge = new Set(sources.map(s => s.url));
  for (const s of acc.streamSources) {
    if (!seenMerge.has(s.url)) { seenMerge.add(s.url); sources.push(s); }
  }
  if (!text.trim() && acc.error) return { text: "", sources, error: acc.error };
  return { text, sources };
}
