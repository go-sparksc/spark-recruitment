"use client";

import { useRouter } from "next/navigation";
import { useCallback, type MouseEvent } from "react";

/// A real back button, distinct from `InstanceCrumbs`.
///
/// The crumbs are *structural* — they always go to the instance hub and to the
/// instance list, whatever route you arrived from. This goes to the page you
/// were actually on, which is the question an admin is asking when they have
/// opened an applicant from a filtered results view and want that view back,
/// filters and scroll position intact. A crumb cannot answer it, because the
/// hub is not where they came from.
///
/// **An anchor first, upgraded to `router.back()` on click.** Decision 33 is
/// explicit that a `<button type="button">` driven by `onClick` is inert before
/// React attaches, measured at ~640 ms on a warm route here — and silently so,
/// which is the part that matters. So this renders a real `<a href>` to a
/// server-supplied fallback: it works with no JavaScript, works during
/// hydration, and is a normal middle-click-to-open-in-a-tab link.
///
/// The click handler is the enhancement, not the mechanism. When it runs it
/// prevents the default and calls `router.back()`, which restores scroll
/// position and any client state the fallback href would discard. When it does
/// not run, the browser follows the href and the admin still gets somewhere
/// sensible.
///
/// **`fallback` is required rather than defaulted**, so every caller has to
/// answer "where does this go if history is empty" — which is a real case: an
/// admin opening a link from Slack has no history to go back to, and a default
/// would quietly send them somewhere the author never thought about.
export function BackButton({
  fallback,
  label = "Back",
  className,
}: {
  /// Where the anchor points. Used verbatim without JavaScript, and as the
  /// destination when there is no history entry to return to.
  fallback: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();

  const onClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // Let the browser handle the clicks that are not "navigate here": a
      // modified click means open elsewhere, and hijacking it would break
      // middle-click and ctrl-click on what is visibly a link.
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.button !== 0) return;

      // **`history.length > 1` is the guard, and it is imperfect on purpose.**
      // There is no way to ask "is there an entry to go back to within this
      // app" — `history.length` counts the whole tab's session, so a fresh tab
      // opened straight onto this page reads 1 and takes the fallback, which is
      // the case that matters. A tab that visited another site first reads more
      // than 1 and `router.back()` may leave the app; that is what the browser
      // back button would do too, and matching it is less surprising than
      // inventing a different rule.
      if (window.history.length <= 1) return;

      event.preventDefault();
      router.back();
    },
    [router],
  );

  return (
    <a href={fallback} onClick={onClick} className={className}>
      ← {label}
    </a>
  );
}
