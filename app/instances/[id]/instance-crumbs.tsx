import Link from "next/link";

/// The two-level crumb every instance page carries: back to FR-1's list, and
/// back to this instance's hub.
///
/// The second link is what makes decision 36 hold in both directions. The hub
/// links out to every surface; without this, none of them links back, and a
/// surface reachable only from one page is one page away from being unreachable
/// again the next time a link moves.
///
/// **Two pages deliberately do not use this**, and both for the same reason:
/// the hub gates on `requireInstance`, so a crumb pointing at it is only honest
/// where the caller already holds the instance password.
///
///   - `/unlock` renders exactly when the session does **not** hold the
///     instance, so a hub link there would bounce straight back to it. Decision
///     29 is why that page links to settings instead — the one route that works
///     from that state.
///   - `/settings` gates on `requireAdmin` alone, deliberately, so that an admin
///     who has lost the instance password can still reach it. A hub crumb there
///     would send precisely that person to `/unlock`, which is the wall FR-5's
///     recovery path exists to get around.
///
/// Both keep a plain `← Instances` link, which works with app-level access
/// alone. If a future page gates on anything less than `requireInstance`, it
/// belongs on this list rather than on this component.
export function InstanceCrumbs({
  instanceId,
  instanceName,
}: {
  instanceId: string;
  instanceName: string;
}) {
  return (
    <p className="text-muted-foreground text-sm">
      <Link href="/" className="hover:underline">
        ← Instances
      </Link>
      <span className="px-1.5">·</span>
      <Link href={`/instances/${instanceId}`} className="hover:underline">
        {instanceName}
      </Link>
    </p>
  );
}
