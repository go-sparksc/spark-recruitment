"use client";

import { useState, useTransition } from "react";

import {
  assignToGroup,
  createGroupFromField,
  dismissProposal,
  mergeGroups,
  nameProposal,
  setFieldRoundSettings,
  setGroupRoundSettings,
  setPromotedRole,
  splitGroup,
  updateField,
  updateGroup,
  type ActionState,
} from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldCategory, FieldGroupRole, PromotedRole } from "@/generated/prisma/enums";

const SELECT =
  "border-input bg-background h-8 rounded-md border px-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed";

/// Every control runs its action through here so a rejected edit says why
/// instead of silently reverting. The server is the only thing that decides
/// whether an edit is allowed; this just reports the answer.
function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<ActionState>) => {
    setError(null);
    start(async () => {
      const result = await action();
      if (result?.error) setError(result.error);
    });
  };

  return { run, pending, error };
}

function Error({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-destructive mt-1 text-xs">
      {message}
    </p>
  );
}

/// Decision 34: after commit, identity is frozen and presentation policy is not.
/// Every control this disables says so rather than sitting greyed out with no
/// account of itself — the same argument import-committed.tsx makes for being a
/// page state rather than a disabled button.
const FROZEN_NOTE = "fixed at commit — it decides what committed data means";

// ---------------------------------------------------------------------------

export interface ProposalView {
  index: number;
  headers: string[];
  columnCount: number;
}

/// A detected group before anyone has confirmed it. Naming it creates the
/// FieldGroup and freezes its key; dismissing it discards it. Leaving it alone
/// is the third state, which FR-3's preview warns about.
export function ProposalCard({
  instanceId,
  proposal,
}: {
  instanceId: string;
  proposal: ProposalView;
}) {
  const [name, setName] = useState("");
  const { run, pending, error } = useAction();

  return (
    <div className="rounded-md border border-amber-500/40 p-4">
      <p className="text-sm font-medium">
        {proposal.columnCount} adjacent columns, every value matching its own header
      </p>
      <ul className="text-muted-foreground mt-2 space-y-0.5 text-sm">
        {proposal.headers.map((header) => (
          <li key={header}>· {header}</li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name this question, e.g. Ethnicity"
          className="h-8 max-w-xs"
          aria-label="Group name"
        />
        <Button
          size="sm"
          disabled={pending || name.trim() === ""}
          onClick={() => run(() => nameProposal(instanceId, proposal.index, name))}
        >
          Create group
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run(() => dismissProposal(instanceId, proposal.index))}
        >
          Dismiss
        </Button>
      </div>

      <p className="text-muted-foreground mt-3 text-xs">
        The name sets a permanent key used by exports. Renaming later changes the heading, not the
        key.
      </p>
      <Error message={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------

/// §6's visibility control, shared by the group panel and the column row so the
/// two cannot drift.
///
/// Two mutually exclusive checkboxes rather than a dropdown or a radio pair, by
/// request. A radio group is the native control for this shape and would get
/// keyboard and screen-reader behaviour for free, so the ARIA roles below are
/// doing by hand what `type="radio"` would have done on its own — without them
/// the pair announces as two independent toggles, which is the one reading that
/// is actually wrong.
///
/// Neither box is ticked when the value is null. That is FR-2's no-default
/// rule made visible: unchosen looks unchosen. There is deliberately no way
/// back to it — clicking a ticked box is a no-op rather than an untick.
function VisibilityChoice({
  value,
  disabled,
  lockedNote,
  forcesBackendOnly,
  onChange,
}: {
  value: boolean | null;
  disabled: boolean;
  /// Set when the choice is not the admin's to make — a demographic column, or
  /// an excluded one. Renders the state read-only with the reason.
  lockedNote: string | null;
  /// True only where the lock actually overrides the stored value, which is the
  /// DEMOGRAPHIC case: §6 hides it whatever is stored, so showing Backend only
  /// is the truth. An EXCLUDED column is different — exclusion hides it without
  /// changing the flag, so it keeps displaying the choice that will take effect
  /// again the moment it is re-included. Showing Backend only there would tell
  /// the admin the opposite of what re-including does.
  forcesBackendOnly: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span className="flex items-center gap-3" role="radiogroup" aria-label="Reviewer visibility">
      <label className="flex items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          role="radio"
          aria-checked={value === true && !forcesBackendOnly}
          checked={value === true && !forcesBackendOnly}
          disabled={disabled || lockedNote !== null}
          onChange={() => onChange(true)}
        />
        Reviewer-visible
      </label>
      <label className="flex items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          role="radio"
          aria-checked={value === false || forcesBackendOnly}
          checked={value === false || forcesBackendOnly}
          disabled={disabled || lockedNote !== null}
          onChange={() => onChange(false)}
        />
        Backend only
      </label>
      {lockedNote !== null ? (
        <span className="text-muted-foreground text-xs">{lockedNote}</span>
      ) : value === null ? (
        <span className="text-xs text-amber-600">not set</span>
      ) : null}
    </span>
  );
}

/// The reason a column's visibility is not the admin's to choose, or null when
/// it is. Mirrors `mustChooseVisibility`'s exemptions in lib/fields.ts — that
/// function decides whether the commit is blocked, this decides what the row
/// says, and they must agree.
function visibilityLock(category: FieldCategory, isIncluded: boolean): string | null {
  if (category === FieldCategory.DEMOGRAPHIC) return "locked: demographics are never shown (§6)";
  if (!isIncluded) return "excluded, so hidden from everyone";
  return null;
}

export interface GroupView {
  id: string;
  key: string;
  displayName: string;
  category: FieldCategory;
  isIncluded: boolean;
  isMultiSelect: boolean;
  isReviewerVisible: boolean | null;
  needsVisibilityChoice: boolean;
  members: { id: string; displayName: string; groupRole: FieldGroupRole | null }[];
}

export function GroupPanel({
  instanceId,
  group,
  otherGroups,
  frozen = false,
}: {
  instanceId: string;
  group: GroupView;
  otherGroups: { id: string; displayName: string }[];
  /// True once the import has committed. Freezes identity — name, category,
  /// multi-select, split and merge — and leaves inclusion and the per-round
  /// toggles live. Decision 34.
  frozen?: boolean;
}) {
  const [name, setName] = useState(group.displayName);
  const [splitting, setSplitting] = useState(false);
  const [splitIds, setSplitIds] = useState<string[]>([]);
  const [splitName, setSplitName] = useState("");
  const { run, pending, error } = useAction();

  const hasFreeText = group.members.some((m) => m.groupRole === FieldGroupRole.FREE_TEXT);

  return (
    <div className="rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== group.displayName && run(() => updateGroup(instanceId, group.id, { displayName: name }))}
          disabled={pending || frozen}
          className="h-8 max-w-xs font-medium"
          aria-label="Group name"
        />
        <code className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs">
          key: {group.key}
        </code>
        <span className="text-muted-foreground text-xs">
          {group.members.length} columns
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Category</span>
          <select
            className={SELECT}
            value={group.category}
            disabled={pending || frozen}
            title={frozen ? `Category is ${FROZEN_NOTE}` : undefined}
            onChange={(e) =>
              run(() => updateGroup(instanceId, group.id, { category: e.target.value as FieldCategory }))
            }
          >
            <option value={FieldCategory.DEMOGRAPHIC}>Demographics</option>
            <option value={FieldCategory.RESPONSE}>Responses</option>
            <option value={FieldCategory.OTHER}>Other</option>
          </select>
        </label>

        {/* Inclusion and the two round toggles below stay live after commit —
            they key nothing and orphan nothing. Decision 34. */}
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={group.isIncluded}
            disabled={pending}
            onChange={(e) =>
              run(() => setGroupRoundSettings(instanceId, group.id, { isIncluded: e.target.checked }))
            }
          />
          Include
        </label>

        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={group.isMultiSelect}
            disabled={pending || frozen}
            title={frozen ? `Multi-select is ${FROZEN_NOTE}` : undefined}
            onChange={(e) => run(() => updateGroup(instanceId, group.id, { isMultiSelect: e.target.checked }))}
          />
          Multi-select
        </label>

        {/* One choice for the whole group, since §5 makes visibility a property
            of the group and not of its members. */}
        <VisibilityChoice
          value={group.isReviewerVisible}
          disabled={pending}
          lockedNote={visibilityLock(group.category, group.isIncluded)}
          forcesBackendOnly={group.category === FieldCategory.DEMOGRAPHIC}
          onChange={(next) =>
            run(() => setGroupRoundSettings(instanceId, group.id, { isReviewerVisible: next }))
          }
        />
      </div>

      {group.isMultiSelect && !hasFreeText ? (
        <p className="text-muted-foreground mt-3 rounded bg-amber-500/10 px-2 py-1.5 text-xs">
          If this question has a free-text write-in column, assign it here as the write-in — it will
          not be detected automatically, because its values vary by definition.
        </p>
      ) : null}

      {/* Split and merge change which group a column belongs to, and the group's
          values are what a member resolves through — so they are identity.
          Hidden rather than disabled once frozen: a group with no structural
          edits left is better read as settled than as broken. */}
      {frozen ? (
        <p className="text-muted-foreground mt-4 text-xs">
          Grouping and category are {FROZEN_NOTE}. Inclusion and the visibility choice above are not.
        </p>
      ) : (
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setSplitting((s) => !s)}>
          {splitting ? "Cancel split" : "Split"}
        </Button>

        {otherGroups.length > 0 ? (
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Merge into this group</span>
            <select
              className={SELECT}
              value=""
              disabled={pending}
              onChange={(e) =>
                e.target.value && run(() => mergeGroups(instanceId, group.id, e.target.value))
              }
            >
              <option value="">Choose…</option>
              {otherGroups.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      )}

      {splitting && !frozen ? (
        <div className="bg-muted/40 mt-3 rounded-md p-3">
          <p className="text-xs font-medium">Move these columns to a new group</p>
          <div className="mt-2 space-y-1">
            {group.members.map((member) => (
              <label key={member.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={splitIds.includes(member.id)}
                  onChange={(e) =>
                    setSplitIds((ids) =>
                      e.target.checked ? [...ids, member.id] : ids.filter((id) => id !== member.id),
                    )
                  }
                />
                {member.displayName}
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              value={splitName}
              onChange={(e) => setSplitName(e.target.value)}
              placeholder="New group name"
              className="h-8 max-w-xs"
              aria-label="New group name"
            />
            <Button
              size="sm"
              disabled={pending || splitIds.length === 0 || splitName.trim() === ""}
              onClick={() =>
                run(async () => {
                  const result = await splitGroup(instanceId, group.id, splitIds, splitName);
                  if (!result?.error) {
                    setSplitting(false);
                    setSplitIds([]);
                    setSplitName("");
                  }
                  return result;
                })
              }
            >
              Split off {splitIds.length || ""}
            </Button>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            The new group takes this group&apos;s category and inclusion, and its own permanent key.
            Splitting off every column moves the group rather than leaving an empty one.
          </p>
        </div>
      ) : null}

      <Error message={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface ColumnView {
  id: string;
  ordinal: number;
  sourceHeader: string;
  displayName: string;
  category: FieldCategory;
  isIncluded: boolean;
  groupId: string | null;
  groupRole: FieldGroupRole | null;
  promotedRole: PromotedRole | null;
  isReviewerVisible: boolean | null;
  /// Resolved through lib/fields.ts, so the row shows what the group actually
  /// imposes rather than what the column happens to store.
  effectiveCategory: FieldCategory;
  effectiveIncluded: boolean;
  inheritedFromGroup: boolean;
  needsVisibilityChoice: boolean;
}

export function ColumnControls({
  instanceId,
  column,
  groups,
  frozen = false,
}: {
  instanceId: string;
  column: ColumnView;
  groups: { id: string; displayName: string }[];
  /// True once the import has committed. Freezes display name, designation,
  /// grouping and category; leaves Include and the round toggles live.
  /// Decision 34.
  frozen?: boolean;
}) {
  const [displayName, setDisplayName] = useState(column.displayName);
  const [newGroupName, setNewGroupName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const { run, pending, error } = useAction();

  const grouped = column.groupId !== null;
  const promoted = column.promotedRole !== null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onBlur={() =>
            displayName !== column.displayName &&
            run(() => updateField(instanceId, column.id, { displayName }))
          }
          disabled={pending || frozen}
          className="h-8 w-56"
          aria-label={`Display name for column ${column.ordinal + 1}`}
        />

        {/* FR-2's designation. A promoted column is un-excludable and cannot be
            grouped, both enforced by a database CHECK. */}
        <select
          className={SELECT}
          value={column.promotedRole ?? ""}
          disabled={pending || grouped || frozen}
          title={frozen ? `The designation is ${FROZEN_NOTE}` : undefined}
          aria-label="Designation"
          onChange={(e) =>
            run(() =>
              setPromotedRole(
                instanceId,
                column.id,
                e.target.value === "" ? null : (e.target.value as PromotedRole),
              ),
            )
          }
        >
          <option value="">no designation</option>
          <option value={PromotedRole.EMAIL}>Email column</option>
          <option value={PromotedRole.NAME}>Name column</option>
        </select>

      </div>

      {creatingGroup ? (
        <div className="bg-muted/40 flex flex-wrap items-center gap-2 rounded-md p-2">
          <Input
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="New group name"
            className="h-8 max-w-xs"
            aria-label="New group name"
          />
          <Button
            size="sm"
            disabled={pending || newGroupName.trim() === ""}
            onClick={() =>
              run(async () => {
                const result = await createGroupFromField(
                  instanceId,
                  column.id,
                  newGroupName,
                  FieldGroupRole.OPTION,
                );
                if (!result?.error) {
                  setCreatingGroup(false);
                  setNewGroupName("");
                }
                return result;
              })
            }
          >
            Create
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCreatingGroup(false)}>
            Cancel
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        <select
          className={SELECT}
          value={column.effectiveCategory}
          disabled={pending || grouped || frozen}
          title={frozen ? `Category is ${FROZEN_NOTE}` : undefined}
          aria-label="Category"
          onChange={(e) =>
            run(() => updateField(instanceId, column.id, { category: e.target.value as FieldCategory }))
          }
        >
          <option value={FieldCategory.DEMOGRAPHIC}>Demographics</option>
          <option value={FieldCategory.RESPONSE}>Responses</option>
          <option value={FieldCategory.OTHER}>Other</option>
        </select>

        {/* Include and the two round toggles below survive commit — decision 34.
            Their existing gating is unchanged: a grouped column defers to its
            group, and a promoted one cannot be excluded at all (FR-2). */}
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={column.effectiveIncluded}
            disabled={pending || grouped || promoted}
            onChange={(e) =>
              run(() => setFieldRoundSettings(instanceId, column.id, { isIncluded: e.target.checked }))
            }
          />
          Include
        </label>

        {/* Offered on every category now, not only OTHER — decision 108. A
            grouped column shows nothing here, since the group carries the
            choice; a promoted column has no Field row after commit. */}
        {!grouped && !promoted ? (
          <VisibilityChoice
            value={column.isReviewerVisible}
            disabled={pending}
            lockedNote={visibilityLock(column.effectiveCategory, column.effectiveIncluded)}
            forcesBackendOnly={column.effectiveCategory === FieldCategory.DEMOGRAPHIC}
            onChange={(next) =>
              run(() => setFieldRoundSettings(instanceId, column.id, { isReviewerVisible: next }))
            }
          />
        ) : null}

        {grouped ? (
          <span className="text-muted-foreground text-xs">
            set on the group
          </span>
        ) : null}
        {promoted ? (
          <span className="text-muted-foreground text-xs">
            promoted out of the data at commit — cannot be excluded
          </span>
        ) : null}
      </div>

      {/* Grouping moved below the category and visibility controls. It used to
          sit up in the identity row beside the display name and the
          designation, which put the three FR-2 decisions an admin actually
          works through — what is this, is it included, who sees it — out of
          order and split across two rows. Group membership is the one that
          overrides the others (§5: the group's values win), so it reads last,
          where its effect on what is above it is visible. */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={SELECT}
          value={column.groupId ?? ""}
          disabled={pending || promoted || frozen}
          title={frozen ? `Grouping is ${FROZEN_NOTE}` : undefined}
          aria-label="Group"
          onChange={(e) => {
            const value = e.target.value;
            if (value === "__new__") {
              setCreatingGroup(true);
              return;
            }
            run(() =>
              assignToGroup(
                instanceId,
                column.id,
                value === "" ? null : value,
                value === "" ? null : (column.groupRole ?? FieldGroupRole.OPTION),
              ),
            );
          }}
        >
          <option value="">No group</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.displayName}
            </option>
          ))}
          <option value="__new__">New group…</option>
        </select>

        {grouped ? (
          <select
            className={SELECT}
            value={column.groupRole ?? FieldGroupRole.OPTION}
            disabled={pending || frozen}
            title={frozen ? `The role in the group is ${FROZEN_NOTE}` : undefined}
            aria-label="Role in group"
            onChange={(e) =>
              run(() =>
                assignToGroup(
                  instanceId,
                  column.id,
                  column.groupId,
                  e.target.value as FieldGroupRole,
                ),
              )
            }
          >
            <option value={FieldGroupRole.OPTION}>option (counted)</option>
            <option value={FieldGroupRole.FREE_TEXT}>write-in (not counted)</option>
          </select>
        ) : null}
      </div>

      <Error message={error} />
    </div>
  );
}
