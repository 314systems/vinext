"use server";

import { redirect } from "next/navigation";

export async function redirectAction() {
  redirect("/success");
}

export async function redirectOtherAction() {
  redirect("/other-success");
}

export async function redirectBoundAction(target: string) {
  redirect(target);
}
