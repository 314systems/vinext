import Link from "next/link";

export default function ScriptNavigationStart() {
  return (
    <main>
      <h1>Script Navigation Start</h1>
      <Link href="/script-navigation-target">Navigate to script target</Link>
    </main>
  );
}
