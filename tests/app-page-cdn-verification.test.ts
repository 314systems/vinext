import { describe, expect, it } from "vite-plus/test";
import { completeCdnCacheCandidateStream } from "../packages/vinext/src/server/app-page-cdn-verification.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("CDN response stream verification", () => {
  it("waits for the complete candidate before replaying it", async () => {
    const release = createDeferred();
    let completed = false;
    const source = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        await release.promise;
        controller.enqueue(new TextEncoder().encode("-second"));
        controller.close();
      },
    });

    const pending = completeCdnCacheCandidateStream(source).then((stream) => {
      completed = true;
      return stream;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    release.resolve();
    const stream = await pending;
    await expect(new Response(stream).text()).resolves.toBe("first-second");
    expect(source.locked).toBe(false);
  });

  it("does not change cacheability at an arbitrary payload size", async () => {
    const payload = new Uint8Array(2 * 1024 * 1024 + 1);
    payload.fill(42);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });

    const stream = await completeCdnCacheCandidateStream(source);
    const replayed = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(replayed.byteLength).toBe(payload.byteLength);
    expect(replayed[0]).toBe(42);
    expect(replayed.at(-1)).toBe(42);
    expect(source.locked).toBe(false);
  });

  it("releases the source lock when completion fails", async () => {
    const failure = new Error("render stream failed");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });

    await expect(completeCdnCacheCandidateStream(source)).rejects.toBe(failure);
    expect(source.locked).toBe(false);
  });
});
