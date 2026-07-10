import type { ImageOptimizer } from "vinext/server/image-optimization";

export default function createImageTestOptimizer(): ImageOptimizer {
  return {
    async transformImage(body) {
      await new Response(body).arrayBuffer();
      throw new Error("intentional image transform failure");
    },
  };
}
