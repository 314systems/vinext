"use server";

import { revalidatePath } from "next/cache";

export async function revalidateParallelSlots() {
  revalidatePath("/");
  return { success: true };
}
