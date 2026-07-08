import { cookies, headers } from "next/headers";
import { ActionButton } from "../../action-button";

export default function Page() {
  const readForwardedCredentials = async () => {
    "use server";
    const auth = (await headers()).get("x-forwarded-auth") ?? "missing";
    const cookie = (await cookies()).get("forwarded-cookie")?.value ?? "missing";
    return `${auth}:${cookie}`;
  };

  return <ActionButton id="forwarded-credentials" action={readForwardedCredentials} />;
}
