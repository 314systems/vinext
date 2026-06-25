import { cookies } from "next/headers";

export default async function MetadataStreamingCookiesSlot() {
  await cookies();
  return <div>Dynamic parallel slot using cookies</div>;
}
