/**
 * Side-effect-free typo-suggestion helpers shared by the top-level CLI command
 * dispatcher (src/cli.ts) and the login provider resolver (src/oauth/login-cli.ts).
 *
 * Contract:
 * - No process access, no stdout/stderr, no filesystem, no config reads.
 * - Case normalization is owned here: inputs and candidates are compared lower-cased.
 * - Deterministic tie handling: candidate iteration order is preserved and the first
 *   candidate with the smallest distance wins.
 */

/** Classic Levenshtein edit distance (case-normalized). */
export function editDistance(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  const prev = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j++) prev[j] = j;
  for (let i = 1; i <= left.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const next = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = prev[j];
      prev[j] = next;
    }
  }
  return prev[right.length];
}

/**
 * Suggest the closest candidate within `maxDistance` edits of `input`, or null.
 * Ties break toward the earliest candidate in iteration order.
 */
export function suggestClosest(
  input: string,
  candidates: Iterable<string>,
  maxDistance = 2,
): string | null {
  let best: string | null = null;
  let bestDist = maxDistance + 1;
  for (const candidate of candidates) {
    const dist = editDistance(input, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}
