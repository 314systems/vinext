import Link from "next/link";
import { connection } from "next/server";

export async function generateMetadata() {
  await connection();
  return { icons: { icon: "/heart.png?v=root" } };
}

export default function Page() {
  return (
    <Link id="metadata-icons-sub-link" href="/metadata-icons-stream/sub">
      Sub icon
    </Link>
  );
}
