import { headers } from "next/headers";

export default async function MetadataStreamingHeadersSlot() {
  await headers();
  return <div>Dynamic parallel slot using headers</div>;
}
