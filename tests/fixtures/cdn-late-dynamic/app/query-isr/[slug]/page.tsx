import QueryEcho from "./client";

export const revalidate = 60;

export default function QueryIsrPage() {
  return (
    <main>
      <h1>Query-aware ISR page</h1>
      <QueryEcho />
    </main>
  );
}
