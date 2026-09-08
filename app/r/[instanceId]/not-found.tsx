"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/// The reviewer area's 404.
///
/// **There was none anywhere under `app/` before this**, so every `notFound()`
/// on a reviewer route rendered Next's stock page: no styling, no explanation,
/// and no link back. A reviewer who hit one had the browser's back button and
/// nothing else, on a phone, having been sent the link in Slack.
///
/// Decision 112 removed the way this was actually being reached — the profile
/// used to 404 the reviewer whose own vote had just resolved the applicant — but
/// that fixed one cause rather than the missing floor underneath it. A stale
/// link, a deleted instance, an applicant id that was never in this round: all
/// still land here, and all still need a way out.
///
/// **The instance id comes from the pathname because `not-found.tsx` is not
/// given params.** That is a Next constraint, not a preference: the file
/// convention renders without the segment's params, so the only source for
/// "which instance was this" is the URL itself. Every reviewer route is
/// `/r/<instanceId>/...`, so the second segment is it. When the path does not
/// have that shape — which should not happen, since this file only covers
/// routes under `/r/[instanceId]` — the link is omitted rather than pointed
/// somewhere invented.
export default function ReviewerNotFound() {
  const pathname = usePathname();
  const segments = (pathname ?? "").split("/").filter(Boolean);
  const instanceId = segments[0] === "r" && segments.length >= 2 ? segments[1] : null;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12">
      <h1 className="text-xl font-semibold tracking-tight">That page isn&rsquo;t here</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        The link may be out of date, or the applicant may not be in the round you are signed in
        for.
      </p>

      {instanceId === null ? null : (
        <p className="mt-6">
          {/* A plain link, so it works before hydration — decision 33's rule
              about controls that are dead in the window before React attaches.
              This page is the one place a reviewer arrives already stuck, and a
              way out that needs JavaScript to work is not one. */}
          <Link
            href={`/r/${instanceId}/list`}
            className="inline-flex min-h-12 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted"
          >
            Back to your applicants
          </Link>
        </p>
      )}

      <p className="text-muted-foreground mt-6 text-sm">
        If you got here from a link in Slack and it keeps happening, tell whoever is running
        recruitment — it is more likely the link than you.
      </p>
    </main>
  );
}
