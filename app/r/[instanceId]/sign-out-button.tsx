"use client";

import { signOut } from "./actions";
import { clearAllDrafts } from "./a/[assignmentId]/draft-store";
import { Button } from "@/components/ui/button";

/// Sign out, and take the offline drafts with it — PRD decision 37.
///
/// **Still a form submit bound to the server action**, so it works before
/// hydration exactly as it did when it was a server component. The only thing
/// this client wrapper adds is the storage clear, and it is attached as an
/// `onSubmit` side effect rather than replacing the submit, so the pre-hydration
/// path is unchanged rather than merely still present.
///
/// The gap that leaves is the one decision 37 names: a sign-out tapped before
/// React attaches signs the reviewer out and leaves the drafts behind, because
/// clearing browser storage is not something a server action can do. The 7-day
/// TTL in draft-store.ts is the backstop for exactly that, which is why this is
/// not the only thing standing between an abandoned phone and a stale note.
export function SignOutButton({ instanceId }: { instanceId: string }) {
  return (
    <form
      action={signOut}
      onSubmit={() => {
        // Deliberately not awaited and deliberately not blocking: if this throws
        // — private browsing, a locked-down browser — the reviewer must still
        // get signed out. draft-store.ts swallows its own storage errors for the
        // same reason.
        clearAllDrafts();
      }}
      // No margin: placement belongs to the caller. This carried `mt-8` while it
      // sat at the foot of the list, which was the list's spacing living in the
      // wrong file — F-19 moved it into the header and the margin went with it.
    >
      <input type="hidden" name="instanceId" value={instanceId} />
      <Button type="submit" variant="outline" size="sm">
        Sign out
      </Button>
    </form>
  );
}
