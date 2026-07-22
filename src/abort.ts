export interface LinkedAbortSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

export function signalWithTimeout(timeoutMs: number, parent?: AbortSignal): LinkedAbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new DOMException("Timeout elapsed", "TimeoutError"));
  }, timeoutMs);

  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(parent?.reason);
  };

  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}
