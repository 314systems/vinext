import { cookies } from "next/headers";

export default async function MetadataStreamingDynamicDefaultSlot() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await cookies();
  return <div>Dynamic active default slot using cookies</div>;
}
