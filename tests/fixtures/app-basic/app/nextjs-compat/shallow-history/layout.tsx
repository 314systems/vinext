import Link from "next/link";

export default function ShallowHistoryLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Link href="/nextjs-compat/shallow-history/target" id="to-shallow-history-target">
        Target
      </Link>
      {children}
    </>
  );
}
