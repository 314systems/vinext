import { headers } from "next/headers";

export default async function MetadataStreamingHeadersSlot() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await headers();
  return <div>Dynamic parallel slot using headers</div>;
}
