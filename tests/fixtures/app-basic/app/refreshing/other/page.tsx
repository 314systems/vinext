import { RefreshControl, RevalidateControl } from "../../parallel-revalidation-controls";

export default function Page() {
  return (
    <main>
      <p data-testid="refreshing-other-token">{Math.random()}</p>
      <RefreshControl />
      <RevalidateControl />
    </main>
  );
}
