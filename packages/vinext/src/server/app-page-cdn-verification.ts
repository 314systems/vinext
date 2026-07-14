/**
 * Fully consume a prospective CDN cache entry before cacheable response headers
 * are committed. Cacheability must not depend on wall-clock time or payload
 * size: the render either completes and can be classified from its observed
 * dynamic usage, or it remains a streaming response that has not yet earned a
 * shared-cache policy.
 *
 * This matches Next.js static generation, which materializes the complete
 * render stream before returning cache metadata:
 * https://github.com/vercel/next.js/blob/ee6e79b1792a4d401ddf2480f40a83549fe8e722/packages/next/src/server/app-render/app-render.tsx#L2514-L2521
 */
export async function completeCdnCacheCandidateStream(
  stream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
