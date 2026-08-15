import * as React from "react"

import { cn } from "@/lib/utils"

/// A plain styled <textarea>, matching input.tsx's surface.
///
/// Not wrapped around a Base UI primitive because Base UI has no textarea. The
/// classes are input.tsx's, minus the fixed height and the file-input rules
/// that do not apply, plus `field-sizing-content` so the box grows with a note
/// rather than making the reviewer scroll a four-line window on a phone.
///
/// `text-base` rather than `text-sm` at every width: iOS Safari zooms the whole
/// page when a focused field's text is under 16px, and a reviewer who gets
/// zoomed into a textarea has to pinch back out to reach the rubric.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input bg-transparent placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 field-sizing-content min-h-24 w-full min-w-0 rounded-lg border px-2.5 py-2 text-base transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
