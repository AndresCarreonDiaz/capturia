// The one contract every speech engine sits behind (M9, issue #8). Engines
// differ wildly (chunked whisper today, Apple SpeechAnalyzer and streaming
// providers later), so the studio codes against these events and never
// against an engine. Also home to the serial queue that keeps a
// one-at-a-time engine (whisper's busy flag) fed in order.

export type TranscriptEngineId = "whisper-chunked" | "web-speech" | "apple-speech";

export interface TranscriptEngineInfo {
  id: TranscriptEngineId;
  // "utterance": text arrives after each pause. "subsecond": live interims.
  latencyClass: "utterance" | "subsecond";
}

export interface TranscriptEvents {
  // Mutable partial text; engines without interims never emit it.
  interim: string;
  // Committed utterance text, trimmed, never empty.
  final: string;
  // Human-readable engine state for the status pill.
  status: string;
  error: string;
}

type Handler<T> = (payload: T) => void;

// Minimal typed emitter; deliberately not Node's EventEmitter so it runs in
// the renderer untouched. Handler errors are contained so one bad subscriber
// cannot kill the capture loop.
export class TranscriptEmitter {
  private handlers: { [K in keyof TranscriptEvents]: Set<Handler<TranscriptEvents[K]>> } = {
    interim: new Set(),
    final: new Set(),
    status: new Set(),
    error: new Set(),
  };

  on<K extends keyof TranscriptEvents>(event: K, handler: Handler<TranscriptEvents[K]>): () => void {
    this.handlers[event].add(handler);
    return () => this.handlers[event].delete(handler);
  }

  emit<K extends keyof TranscriptEvents>(event: K, payload: TranscriptEvents[K]): void {
    for (const handler of this.handlers[event]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`transcript ${event} handler threw:`, err);
      }
    }
  }

  clear(): void {
    for (const set of Object.values(this.handlers)) set.clear();
  }
}

// Serial async queue: tasks run one at a time in enqueue order. A rejected
// task reports through onError and never breaks the chain, so a failed
// transcription does not silence every utterance after it.
export function createSerialQueue(onError: (err: unknown) => void = () => {}) {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  const run = (task: () => Promise<void>): Promise<void> => {
    pending += 1;
    const next = tail
      .then(task)
      .catch(onError)
      .finally(() => {
        pending -= 1;
      });
    tail = next;
    return next;
  };
  run.pendingCount = () => pending;
  return run;
}
