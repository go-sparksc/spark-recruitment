import { redirect } from "next/navigation";

import { LoginForm } from "./login-form";
import { isSignedIn } from "@/lib/auth";
import { safeRedirect } from "@/lib/session";

export const metadata = { title: "Sign in — Spark SC Recruitment" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const destination = safeRedirect(next);

  if (await isSignedIn()) redirect(destination);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Spark SC Recruitment</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Admin access. Applicant data is behind this page.
      </p>

      <LoginForm next={destination} />
    </main>
  );
}
