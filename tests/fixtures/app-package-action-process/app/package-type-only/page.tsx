import type { PackageActionLabel } from "dev-package-action/type-only";

const label: PackageActionLabel = "Package type-only edge";

export default function PackageTypeOnlyPage() {
  return <p>{label}</p>;
}
