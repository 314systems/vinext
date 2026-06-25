import { headers } from "next/headers";

export const revalidate = 60;

export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return {
    title: "Body dynamic streamed metadata",
    description: "Static metadata follows dynamic page content",
  };
}

export default async function MetadataStreamingBodyDynamicPage() {
  await headers();
  return <main>Body-only dynamic metadata page</main>;
}
