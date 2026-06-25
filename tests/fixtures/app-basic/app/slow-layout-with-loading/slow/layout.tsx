import { type ReactNode, use } from "react";

async function getData() {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return "Slow layout loaded";
}

export default function SlowLayout({ children }: { children: ReactNode }) {
  const message = use(getData());

  return (
    <section>
      <p id="slow-layout-message">{message}</p>
      {children}
    </section>
  );
}
