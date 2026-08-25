// SPDX-License-Identifier: MIT
// AC-6.3 / D-6: the batched receipt reporter. Signing is synchronous with
// the decision; POSTing is async, batched, fire-and-forget with backoff,
// and NEVER blocks or fails a request. The queue is bounded drop-oldest and
// drops are counted for the observe report. Default endpoint: none - this
// whole module is idle unless the operator turns reporting on (Article I.4:
// fully functional with it off, forever).
import type { Receipt } from "./receipt.js";

export interface ReporterOptions {
  url: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  batchSize?: number;
  flushIntervalMs?: number;
  queueMax?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Off in tests: flush() is then driven manually. */
  autoFlush?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // never hold a Node process open just to report
    (timer as { unref?: () => void }).unref?.();
  });

export class ReceiptReporter {
  private readonly queue: Receipt[] = [];
  private droppedCount = 0;
  private backoff = 0;
  private running = false;

  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly queueMax: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly autoFlush: boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ReporterOptions) {
    this.url = options.url;
    this.fetchFn = options.fetchFn ?? fetch;
    this.batchSize = options.batchSize ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.queueMax = options.queueMax ?? 1000;
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.backoffCapMs = options.backoffCapMs ?? 60_000;
    this.autoFlush = options.autoFlush ?? true;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Synchronous, never throws, never blocks: bounded push, drop-oldest. */
  enqueue(receipt: Receipt): void {
    if (this.queue.length >= this.queueMax) {
      this.queue.shift();
      this.droppedCount += 1;
    }
    this.queue.push(receipt);
    if (this.autoFlush) this.ensureLoop();
  }

  private ensureLoop(): void {
    if (this.running) return;
    this.running = true;
    void (async () => {
      while (this.running && this.queue.length > 0) {
        await this.sleep(this.flushIntervalMs + this.backoff);
        await this.flush();
      }
      this.running = false;
    })();
  }

  /** Drain in batches; a failed POST requeues its batch and backs off. Never throws. */
  async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      try {
        const resp = await this.fetchFn(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ v: 1, receipts: batch }),
        });
        if (!resp.ok) throw new Error(`ingest ${resp.status}`);
        this.backoff = 0;
      } catch {
        this.queue.unshift(...batch);
        const overflow = this.queue.length - this.queueMax;
        if (overflow > 0) {
          this.queue.splice(0, overflow);
          this.droppedCount += overflow;
        }
        this.backoff = Math.min(
          this.backoff === 0 ? this.backoffBaseMs : this.backoff * 2,
          this.backoffCapMs,
        );
        return; // stop draining this round; the loop retries after backoff
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get queued(): number {
    return this.queue.length;
  }

  get backoffMs(): number {
    return this.backoff;
  }
}
