import {
  RefreshControl,
  RevalidateControl,
  SerializedRevalidateControl,
} from "../../parallel-revalidation-controls";

export default function Page() {
  return (
    <main data-testid="refreshing-other-page">
      <p data-testid="refreshing-other-token">{Math.random()}</p>
      <RefreshControl />
      <RevalidateControl />
      <SerializedRevalidateControl />
    </main>
  );
}
