import Link from "next/link";

import { NewInstanceForm } from "./new-instance-form";
import { requireAdmin } from "@/lib/auth";

export const metadata = { title: "New instance — Spark SC Recruitment" };

export default async function NewInstancePage() {
  await requireAdmin("/instances/new");

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-16">
      <Link href="/" className="text-muted-foreground text-sm hover:underline">
        ← Instances
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">New instance from CSV</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        One recruitment cycle, imported from the application export. You will confirm what each
        column means before anything is created.
      </p>

      <NewInstanceForm />
    </main>
  );
}
