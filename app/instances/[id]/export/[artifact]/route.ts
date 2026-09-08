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

import { loadApplicantsCsv, loadDecisionsCsv, loadFinalClassCsv } from "../load";
import { requireInstance } from "@/lib/auth";
import { serializeExport } from "@/lib/export";
import {
  buildApplicantsCsv,
  buildDecisionsCsv,
  buildFinalClassCsv,
  withUtf8Bom,
} from "@/lib/export-csv";
import { exportFilename, readSnapshot } from "@/lib/instance-io";
import { prisma } from "@/lib/prisma";

/// Never prerendered and never cached. The response contains applicant data and
/// credential hashes, so a cached copy is a copy of the instance sitting
/// somewhere nobody is thinking about.
export const dynamic = "force-dynamic";

/// The closed vocabulary of downloadable artifacts. The JSON is the one FR-20
/// calls "the entire instance" and the only one the round trip reads back; the
/// three CSVs are its per-stage convenience derivatives.
const ARTIFACTS = [
  "instance.json",
  "applicants.csv",
  "decisions.csv",
  "final-class.csv",
] as const;
type Artifact = (typeof ARTIFACTS)[number];

function isArtifact(value: string): value is Artifact {
  return (ARTIFACTS as readonly string[]).includes(value);
}

/// Text and a filename stem. The stem is prefixed with the instance's own slug
/// by the caller, for the reason `exportFilename` gives: these land in a
/// downloads folder beside other cycles' files.
async function buildCsv(artifact: Exclude<Artifact, "instance.json">, instanceId: string) {
  switch (artifact) {
    case "applicants.csv": {
      const { applicants, categories } = await loadApplicantsCsv(instanceId);
      return { body: buildApplicantsCsv(applicants, categories), stem: "applicants" };
    }
    case "decisions.csv":
      return { body: buildDecisionsCsv(await loadDecisionsCsv(instanceId)), stem: "decisions" };
    case "final-class.csv":
      return { body: buildFinalClassCsv(await loadFinalClassCsv(instanceId)), stem: "final-class" };
  }
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

  if (artifact === "instance.json") {
    const snapshot = await readSnapshot(prisma, id);
    return new Response(serializeExport(snapshot), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(instance.name, snapshot.generatedAt)}"`,
        "Cache-Control": "no-store, max-age=0",
      },
    });
  }

  const { body: csv, stem } = await buildCsv(artifact, id);
  // See `withUtf8Bom`. Without it Excel decodes these as Windows-1252 and any
  // non-ASCII name arrives as mojibake — the header below is not enough, because
  // it does not survive the file being written to disk.
  const body = withUtf8Bom(csv);
  const filename = exportFilename(`${instance.name} ${stem}`, new Date().toISOString()).replace(
    /\.json$/,
    ".csv",
  );

  return new Response(body, {
    status: 200,
    headers: {
      // `text/csv` with an explicit charset: these carry names and essay text,
      // and a spreadsheet that guesses the encoding gets non-ASCII names wrong.
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Same reasoning as the JSON. Less credential-bearing, equally full of
      // applicant data.
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
