import DynamicErrorQueryEcho from "./client";

export const dynamic = "error";
export const revalidate = 60;

export default function DynamicErrorClientSearchParamsPage() {
  return (
    <main>
      <h1>Dynamic-error client search params</h1>
      <DynamicErrorQueryEcho />
    </main>
  );
}
