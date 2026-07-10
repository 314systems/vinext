export default function createImageTestOptimizer() {
  return {
    async transformImage(body) {
      await new Response(body).arrayBuffer();
      throw new Error("intentional image transform failure");
    },
  };
}
