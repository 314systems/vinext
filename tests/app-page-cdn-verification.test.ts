import { describe, expect, it } from "vite-plus/test";
import { verifyCdnCacheCandidateStream } from "../packages/vinext/src/server/app-page-cdn-verification.js";

async function readChunks(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("CDN response stream verification", () => {
  it("cannot be kept alive by an infinite synchronous stream of empty chunks", async () => {
    let pulls = 0;
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        cancelled = true;
      },
    });

    const startedAt = performance.now();
    const result = await Promise.race([
      verifyCdnCacheCandidateStream(source, { deadlineMs: 20, maxBytes: 1024 }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("verification starved the event loop")), 500),
      ),
    ]);

    expect(result.complete).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(pulls).toBeGreaterThan(0);
    expect(source.locked).toBe(true);

    await result.stream.cancel("test complete");
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
  });

  it("coalesces many tiny chunks into a bounded number of replay chunks", async () => {
    const chunkCount = 10_000;
    let emitted = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted === chunkCount) {
          controller.close();
          return;
        }
        controller.enqueue(Uint8Array.of(emitted % 251));
        emitted += 1;
      },
    });

    const result = await verifyCdnCacheCandidateStream(source, {
      deadlineMs: 2_000,
      maxBytes: chunkCount,
    });
    expect(result.complete).toBe(true);
    expect(source.locked).toBe(false);

    const chunks = await readChunks(result.stream);
    expect(chunks.length).toBeLessThanOrEqual(16);
    expect(chunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(chunkCount);
  });

  it("releases the source lock when a timed-out response is cancelled", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true;
      },
    });

    const result = await verifyCdnCacheCandidateStream(source, {
      deadlineMs: 5,
      maxBytes: 1024,
    });
    expect(result.complete).toBe(false);
    expect(source.locked).toBe(true);

    await result.stream.cancel("client disconnected");
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
  });

  it("releases the source lock when an oversized response is cancelled", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
        controller.enqueue(Uint8Array.of(3, 4, 5, 6));
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await verifyCdnCacheCandidateStream(source, {
      deadlineMs: 1_000,
      maxBytes: 3,
    });
    expect(result.complete).toBe(false);
    expect(source.locked).toBe(true);

    await result.stream.cancel("response rejected");
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
  });

  it("replays an oversized prefix in order and releases after consumption", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("ab"));
        controller.enqueue(encoder.encode("cdef"));
        controller.enqueue(encoder.encode("gh"));
        controller.close();
      },
    });

    const result = await verifyCdnCacheCandidateStream(source, {
      deadlineMs: 1_000,
      maxBytes: 3,
    });
    expect(result.complete).toBe(false);
    await expect(new Response(result.stream).text()).resolves.toBe("abcdefgh");
    expect(source.locked).toBe(false);
  });

  it("releases the source lock when the initial read errors", async () => {
    const failure = new Error("render stream failed");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });

    await expect(
      verifyCdnCacheCandidateStream(source, { deadlineMs: 1_000, maxBytes: 1024 }),
    ).rejects.toBe(failure);
    expect(source.locked).toBe(false);
  });

  it("releases the source lock when a resumed read errors", async () => {
    const failure = new Error("late render stream failure");
    let reads = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(Uint8Array.of(1, 2, 3, 4));
        } else {
          controller.error(failure);
        }
      },
    });

    const result = await verifyCdnCacheCandidateStream(source, {
      deadlineMs: 1_000,
      maxBytes: 2,
    });
    expect(result.complete).toBe(false);
    await expect(new Response(result.stream).arrayBuffer()).rejects.toBe(failure);
    expect(source.locked).toBe(false);
  });
});
