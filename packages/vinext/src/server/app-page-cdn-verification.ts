export const CDN_DYNAMIC_VERIFICATION_DEADLINE_MS = 100;
export const CDN_DYNAMIC_VERIFICATION_MAX_BYTES = 1024 * 1024;

const MAX_BUFFER_SEGMENTS = 16;
const READS_BEFORE_TASK_YIELD = 64;

type StreamRead = ReadableStreamReadResult<Uint8Array>;

export type CdnStreamVerificationResult = {
  complete: boolean;
  stream: ReadableStream<Uint8Array>;
};

type ReaderOwner = {
  cancel(reason?: unknown): Promise<void>;
  read(): Promise<StreamRead>;
  release(): void;
};

function createReaderOwner(reader: ReadableStreamDefaultReader<Uint8Array>): ReaderOwner {
  let released = false;

  const release = (): void => {
    if (released) return;
    reader.releaseLock();
    released = true;
  };

  return {
    async cancel(reason) {
      if (released) return;
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
    read() {
      return reader.read();
    },
    release,
  };
}

class BoundedStreamBuffer {
  readonly #maxBytes: number;
  readonly #segmentBytes: number;
  readonly #segments: Uint8Array[] = [];
  #length = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
    this.#segmentBytes = Math.max(1, Math.ceil(maxBytes / MAX_BUFFER_SEGMENTS));
  }

  append(chunk: Uint8Array): boolean {
    if (chunk.byteLength > this.#maxBytes - this.#length) return false;

    let sourceOffset = 0;
    while (sourceOffset < chunk.byteLength) {
      let segment = this.#segments.at(-1);
      const usedInSegment = this.#length % this.#segmentBytes;
      if (!segment || usedInSegment === 0) {
        const remainingCapacity = this.#maxBytes - this.#length;
        segment = new Uint8Array(Math.min(this.#segmentBytes, remainingCapacity));
        this.#segments.push(segment);
      }
      const writable = Math.min(
        segment.byteLength - usedInSegment,
        chunk.byteLength - sourceOffset,
      );
      segment.set(chunk.subarray(sourceOffset, sourceOffset + writable), usedInSegment);
      sourceOffset += writable;
      this.#length += writable;
    }
    return true;
  }

  chunks(): Uint8Array[] {
    if (this.#length === 0) return [];
    const finalLength = this.#length % this.#segmentBytes;
    return this.#segments.map((segment, index) =>
      index === this.#segments.length - 1 && finalLength !== 0
        ? segment.subarray(0, finalLength)
        : segment,
    );
  }
}

function replayBufferedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function resumeBufferedStream(
  chunks: Uint8Array[],
  owner: ReaderOwner,
  pendingRead: Promise<StreamRead> | null,
): ReadableStream<Uint8Array> {
  let chunkIndex = 0;
  let nextRead = pendingRead;

  return new ReadableStream({
    async pull(controller) {
      if (chunkIndex < chunks.length) {
        controller.enqueue(chunks[chunkIndex++]);
        return;
      }

      try {
        const result = await (nextRead ?? owner.read());
        nextRead = null;
        if (result.done) {
          owner.release();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        await owner.cancel(error).catch(() => {});
      }
    },
    async cancel(reason) {
      await owner.cancel(reason);
    },
  });
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/**
 * Drain a prospective CDN cache entry only while verification stays cheap.
 * If it exceeds either bound, hand the bounded, coalesced prefix and locked
 * reader back as one continuous stream so the response can leave as `no-store`.
 */
export async function verifyCdnCacheCandidateStream(
  stream: ReadableStream<Uint8Array>,
  options?: { deadlineMs?: number; maxBytes?: number },
): Promise<CdnStreamVerificationResult> {
  const deadlineMs = finiteNonNegative(options?.deadlineMs, CDN_DYNAMIC_VERIFICATION_DEADLINE_MS);
  const maxBytes = Math.floor(
    Math.min(
      finiteNonNegative(options?.maxBytes, CDN_DYNAMIC_VERIFICATION_MAX_BYTES),
      CDN_DYNAMIC_VERIFICATION_MAX_BYTES,
    ),
  );
  const owner = createReaderOwner(stream.getReader());
  const buffer = new BoundedStreamBuffer(maxBytes);
  const startedAt = performance.now();
  let reads = 0;
  let ownershipTransferred = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });

  const deadlineElapsed = (): boolean => performance.now() - startedAt >= deadlineMs;
  const handOff = (
    chunks: Uint8Array[],
    pendingRead: Promise<StreamRead> | null,
  ): CdnStreamVerificationResult => {
    const resumed = resumeBufferedStream(chunks, owner, pendingRead);
    ownershipTransferred = true;
    return { complete: false, stream: resumed };
  };

  try {
    for (;;) {
      if (deadlineElapsed()) return handOff(buffer.chunks(), null);

      const pendingRead = owner.read();
      const outcome = await Promise.race([
        pendingRead.then((result) => ({ kind: "read" as const, result })),
        deadline.then(() => ({ kind: "deadline" as const })),
      ]);

      if (outcome.kind === "deadline") {
        return handOff(buffer.chunks(), pendingRead);
      }

      if (outcome.result.done) {
        return { complete: true, stream: replayBufferedStream(buffer.chunks()) };
      }

      reads += 1;
      if (outcome.result.value.byteLength > 0 && !buffer.append(outcome.result.value)) {
        return handOff([...buffer.chunks(), outcome.result.value], null);
      }

      if (deadlineElapsed()) return handOff(buffer.chunks(), null);

      // A source that resolves reads synchronously can starve the timer forever.
      // Yield periodically so timers/cancellation run, while the elapsed-time
      // checks above keep the total verifier work bounded even without a timer.
      if (reads % READS_BEFORE_TASK_YIELD === 0) {
        await nextTask();
        if (deadlineElapsed()) return handOff(buffer.chunks(), null);
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!ownershipTransferred) owner.release();
  }
}
