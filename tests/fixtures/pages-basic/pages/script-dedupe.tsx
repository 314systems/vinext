import Script from "next/script";

export default function ScriptDedupePage() {
  return (
    <main>
      <h1>Script Dedupe</h1>
      <Script id="page-after-one" src="/dedupe-script.js" />
      <Script id="page-after-two" src="/dedupe-script.js" />
    </main>
  );
}
