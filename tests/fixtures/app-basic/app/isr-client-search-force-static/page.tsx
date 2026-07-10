import ForceStaticQueryEcho from "./client";

export const dynamic = "force-static";
export const revalidate = 60;

export default function ForceStaticClientSearchParamsPage() {
  return (
    <main>
      <h1>Force-static client search params</h1>
      <ForceStaticQueryEcho />
    </main>
  );
}
