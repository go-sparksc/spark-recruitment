import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/// FR-3's refusal. An instance accepts exactly one CSV and commit is final.
///
/// Rendered as an explanation above the mapping table rather than instead of it.
/// It used to replace the whole page, which is how decision 34's defect arose:
/// the per-round visibility controls went down with the structural ones, and
/// §6's "configurable" OTHER row had nowhere left to be configured.
///
/// Three properties this message has to have — it names the one correction path
/// that actually exists, it states what that path costs, and it says plainly
/// that the other path does not exist rather than implying it does. Editing
/// applicants in place is a later phase, and pretending otherwise would send an
/// admin looking for a screen that is not there.
///
/// A fourth, added with decision 34: it must not overstate what is frozen. An
/// admin who reads "that import is final" and concludes the table below is
/// decorative is exactly as stuck as one who could not reach it.
export function ImportCommitted({
  instanceId,
  instanceName,
  applicantCount,
  committedAt,
}: {
  instanceId: string;
  instanceName: string;
  applicantCount: number;
  committedAt: Date;
}) {
  const when = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(committedAt);

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>This instance already has its applicants.</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>
          {instanceName} imported {applicantCount} applicant{applicantCount === 1 ? "" : "s"} from a
          CSV on {when}. An instance accepts exactly one file, and that import is final.
        </p>
        <p>
          To import a corrected file, delete this instance and start again. Deleting removes its{" "}
          {applicantCount} applicant{applicantCount === 1 ? "" : "s"} and everything attached to
          them, permanently, with no undo.
        </p>
        <p>
          <strong className="font-medium">What is still yours to change:</strong> whether a column is
          included, and which rounds can see it. Those are below and stay editable for the whole
          cycle — a round happens weeks after an import, and deciding what reviewers see is not a
          decision anyone makes while mapping CSV columns. What is fixed is what each column{" "}
          <em>means</em>: its display name, its email or name designation, its grouping and its
          category.
        </p>
        <p className="text-muted-foreground">
          Editing individual applicants in place is not available yet.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/instances/${instanceId}/rubric`}
            className={buttonVariants({ size: "sm" })}
          >
            Set up the rubric →
          </Link>
          <Link
            href={`/instances/${instanceId}/settings`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Instance settings
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
