import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/// FR-3's refusal. An instance accepts exactly one CSV and commit is final.
///
/// Rendered as a page state rather than a disabled control: a refusal that lives
/// in a greyed-out button is not a refusal, and it does not explain anything.
///
/// Three properties this message has to have — it names the one correction path
/// that actually exists, it states what that path costs, and it says plainly
/// that the other path does not exist rather than implying it does. Editing
/// applicants in place is a later phase, and pretending otherwise would send an
/// admin looking for a screen that is not there.
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
