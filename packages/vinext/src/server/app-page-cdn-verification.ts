export const CDN_DYNAMIC_VERIFICATION_DEADLINE_MS = 100;
export const CDN_DYNAMIC_VERIFICATION_MAX_BYTES = 1024 * 1024;

type StreamRead = ReadableStreamReadResult<Uint8Array>;

export type CdnStreamVerificationResult = {
  complete: boolean;
  stream: ReadableStream<Uint8Array>;
};

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
  reader: ReadableStreamDefaultReader<Uint8Array>,
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
        const result = await (nextRead ?? reader.read());
        nextRead = null;
        if (result.done) {
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/**
 * Drain a prospective CDN cache entry only while verification stays cheap.
 * If it exceeds either bound, hand the already-read prefix and locked reader
 * back as one continuous stream so the response can leave as `no-store`.
 */
export async function verifyCdnCacheCandidateStream(
  stream: ReadableStream<Uint8Array>,
  options?: { deadlineMs?: number; maxBytes?: number },
): Promise<CdnStreamVerificationResult> {
  const deadlineMs = options?.deadlineMs ?? CDN_DYNAMIC_VERIFICATION_DEADLINE_MS;
  const maxBytes = options?.maxBytes ?? CDN_DYNAMIC_VERIFICATION_MAX_BYTES;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });

  try {
    for (;;) {
      const pendingRead = reader.read();
      const outcome = await Promise.race([
        pendingRead.then((result) => ({ kind: "read" as const, result })),
        deadline.then(() => ({ kind: "deadline" as const })),
      ]);

      if (outcome.kind === "deadline") {
        return {
          complete: false,
          stream: resumeBufferedStream(chunks, reader, pendingRead),
        };
      }

      if (outcome.result.done) {
        reader.releaseLock();
        return { complete: true, stream: replayBufferedStream(chunks) };
      }

      chunks.push(outcome.result.value);
      totalBytes += outcome.result.value.byteLength;
      if (totalBytes > maxBytes) {
        return {
          complete: false,
          stream: resumeBufferedStream(chunks, reader, null),
        };
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
