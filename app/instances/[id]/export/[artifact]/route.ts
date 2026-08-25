// FR-20's download. A Route Handler rather than a server action, per clause 20h.
//
// PRD decision 8 measured this: a real 150-applicant export with five essays
// each exceeds Next's 1 MB server-action body limit, which is the same
// measurement that put `ImportRow` in the database instead of in the browser. A
// server action also has no way to set Content-Disposition, so the file would
// arrive as a string for the client to reassemble rather than as a download.
//
// **The file is credential-bearing** (decision 86): it carries
// `Instance.passwordHash` and every `RoundAccessCode.codeHash`, which is a
// deliberate exception to CLAUDE.md rule 4 so that a restored instance can be
// opened. Two consequences are enforced here rather than left to the page —
// `requireInstance` gates every artifact, and nothing about the response is
// cacheable.

import { requireInstance } from "@/lib/auth";
import { serializeExport } from "@/lib/export";
import { exportFilename, readSnapshot } from "@/lib/instance-io";
import { prisma } from "@/lib/prisma";

/// Never prerendered and never cached. The response contains applicant data and
/// credential hashes, so a cached copy is a copy of the instance sitting
/// somewhere nobody is thinking about.
export const dynamic = "force-dynamic";

/// The closed vocabulary of downloadable artifacts. Slice 4 adds the three
/// per-stage CSVs here; the JSON is the one FR-20 calls "the entire instance"
/// and the only one the round trip reads back.
const ARTIFACTS = ["instance.json"] as const;
type Artifact = (typeof ARTIFACTS)[number];

function isArtifact(value: string): value is Artifact {
  return (ARTIFACTS as readonly string[]).includes(value);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; artifact: string }> },
) {
  const { id, artifact } = await params;

  // Same gate as every other admin surface. `requireInstance` redirects rather
  // than throwing, which in a Route Handler is a 307 to /login or /unlock —
  // the right answer for a link someone followed from a bookmark.
  await requireInstance(id, `/instances/${id}/export`);

  if (!isArtifact(artifact)) {
    return new Response(`No such export artifact: ${artifact}`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const instance = await prisma.instance.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!instance) {
    return new Response("No such instance.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const snapshot = await readSnapshot(prisma, id);
  const body = serializeExport(snapshot);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(instance.name, snapshot.generatedAt)}"`,
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
