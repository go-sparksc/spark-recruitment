"use client";

import { useActionState } from "react";

import { uploadInterviewSheet, type InterviewImportState } from "./actions";
import { Button } from "@/components/ui/button";

/// A form bound to a server action rather than an onClick handler, the same
/// posture decision 35 argued for FR-3's commit. React ships this with
/// `method="POST"` and hidden action fields, so it submits natively before
/// hydration rather than being inert and then firing instantly afterwards.
export function UploadForm({
  instanceId,
  sheet,
  label,
  hasStaged,
}: {
  instanceId: string;
  sheet: "SCORES" | "NOTES";
  label: string;
  /// A sheet already staged is about to be replaced, per clause 12r. Saying so
  /// beforehand is the difference between an upload and a surprise.
  hasStaged: boolean;
}) {
  const [state, action, pending] = useActionState<InterviewImportState, FormData>(
    uploadInterviewSheet,
    {},
  );

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="sheet" value={sheet} />

      <input
        type="file"
        name="file"
        accept=".csv,text/csv"
        required
        disabled={pending}
        aria-label={`${label} CSV`}
        className="text-sm file:mr-3 file:rounded-md file:border file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
      />

      {hasStaged ? (
        <p className="text-muted-foreground text-xs">
          A file is already staged for this sheet. Uploading replaces it — nothing already imported
          is affected until you import again.
        </p>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Reading…" : hasStaged ? "Replace staged file" : "Upload"}
      </Button>
    </form>
  );
}
