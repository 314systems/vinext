import { connection } from "next/server";

export default async function MetadataStreamingConnectionSlot() {
  await connection();
  return <div>Dynamic parallel slot using connection</div>;
}
