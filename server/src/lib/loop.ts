export interface LoopOptions {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
  log: { error: (obj: object, msg: string) => void };
}

export interface Loop {
  /** Runs as soon as the current run (if any) finishes, instead of waiting for the timer. */
  wake(): void;
  /** Stops scheduling new runs and resolves once the current run has finished. */
  stop(): Promise<void>;
}

/**
 * Runs `run` now and then `intervalMs` after each run completes. Runs never overlap, and
 * a failing run is logged without stopping the loop.
 */
export function startLoop({ name, intervalMs, run, log }: LoopOptions): Loop {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> | undefined;
  let wakeRequested = false;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(tick, delay);
  };

  const tick = () => {
    timer = undefined;
    current = (async () => {
      try {
        await run();
      } catch (err) {
        log.error({ err, loop: name }, `${name} loop run failed`);
      }
    })().finally(() => {
      current = undefined;
      const delay = wakeRequested ? 0 : intervalMs;
      wakeRequested = false;
      schedule(delay);
    });
  };

  schedule(0);

  return {
    wake() {
      if (stopped) return;
      if (current) {
        wakeRequested = true;
        return;
      }
      if (timer) clearTimeout(timer);
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
