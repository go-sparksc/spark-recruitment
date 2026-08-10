"use client";

import { useState, useTransition } from "react";

import {
  assignToGroup,
  createGroupFromField,
  dismissProposal,
  mergeGroups,
  nameProposal,
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

export interface GroupView {
  id: string;
  key: string;
  displayName: string;
  category: FieldCategory;
  isIncluded: boolean;
  isMultiSelect: boolean;
  visibleToWrittenReviewer: boolean | null;
  visibleToFirstRoundReviewer: boolean | null;
  members: { id: string; displayName: string; groupRole: FieldGroupRole | null }[];
}

export function GroupPanel({
  instanceId,
  group,
  otherGroups,
}: {
  instanceId: string;
  group: GroupView;
  otherGroups: { id: string; displayName: string }[];
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
            disabled={pending}
            onChange={(e) =>
              run(() => updateGroup(instanceId, group.id, { category: e.target.value as FieldCategory }))
            }
          >
            <option value={FieldCategory.DEMOGRAPHIC}>Demographics</option>
            <option value={FieldCategory.RESPONSE}>Responses</option>
            <option value={FieldCategory.OTHER}>Other</option>
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={group.isIncluded}
            disabled={pending}
            onChange={(e) => run(() => updateGroup(instanceId, group.id, { isIncluded: e.target.checked }))}
          />
          Include
        </label>

        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={group.isMultiSelect}
            disabled={pending}
            onChange={(e) => run(() => updateGroup(instanceId, group.id, { isMultiSelect: e.target.checked }))}
          />
          Multi-select
        </label>

        {/* §6 makes only OTHER configurable per round. For the other two the
            toggles would be stored and never read, so they are not offered. */}
        {group.category === FieldCategory.OTHER ? (
          <>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={group.visibleToWrittenReviewer ?? false}
                disabled={pending || !group.isIncluded}
                onChange={(e) =>
                  run(() => updateGroup(instanceId, group.id, { visibleToWrittenReviewer: e.target.checked }))
                }
              />
              Written reviewers
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={group.visibleToFirstRoundReviewer ?? false}
                disabled={pending || !group.isIncluded}
                onChange={(e) =>
                  run(() =>
                    updateGroup(instanceId, group.id, { visibleToFirstRoundReviewer: e.target.checked }),
                  )
                }
              />
              First-round reviewers
            </label>
          </>
        ) : (
          <span className="text-muted-foreground text-xs">
            {group.category === FieldCategory.DEMOGRAPHIC
              ? "Hidden from written and first-round reviewers (§6)"
              : "Visible to written reviewers, hidden from first round (§6)"}
          </span>
        )}
      </div>

      {group.isMultiSelect && !hasFreeText ? (
        <p className="text-muted-foreground mt-3 rounded bg-amber-500/10 px-2 py-1.5 text-xs">
          If this question has a free-text write-in column, assign it here as the write-in — it will
          not be detected automatically, because its values vary by definition.
        </p>
      ) : null}

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

      {splitting ? (
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
  visibleToWrittenReviewer: boolean | null;
  visibleToFirstRoundReviewer: boolean | null;
  /// Resolved through lib/fields.ts, so the row shows what the group actually
  /// imposes rather than what the column happens to store.
  effectiveCategory: FieldCategory;
  effectiveIncluded: boolean;
  inheritedFromGroup: boolean;
}

export function ColumnControls({
  instanceId,
  column,
  groups,
}: {
  instanceId: string;
  column: ColumnView;
  groups: { id: string; displayName: string }[];
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
          className="h-8 w-56"
          aria-label={`Display name for column ${column.ordinal + 1}`}
        />

        {/* FR-2's designation. A promoted column is un-excludable and cannot be
            grouped, both enforced by a database CHECK. */}
        <select
          className={SELECT}
          value={column.promotedRole ?? ""}
          disabled={pending || grouped}
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

        <select
          className={SELECT}
          value={column.groupId ?? ""}
          disabled={pending || promoted}
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
          <option value="">no group</option>
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
            disabled={pending}
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
          disabled={pending || grouped}
          aria-label="Category"
          onChange={(e) =>
            run(() => updateField(instanceId, column.id, { category: e.target.value as FieldCategory }))
          }
        >
          <option value={FieldCategory.DEMOGRAPHIC}>Demographics</option>
          <option value={FieldCategory.RESPONSE}>Responses</option>
          <option value={FieldCategory.OTHER}>Other</option>
        </select>

        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={column.effectiveIncluded}
            disabled={pending || grouped || promoted}
            onChange={(e) => run(() => updateField(instanceId, column.id, { isIncluded: e.target.checked }))}
          />
          Include
        </label>

        {!grouped && column.effectiveCategory === FieldCategory.OTHER ? (
          <>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={column.visibleToWrittenReviewer ?? false}
                disabled={pending || !column.effectiveIncluded}
                onChange={(e) =>
                  run(() =>
                    updateField(instanceId, column.id, { visibleToWrittenReviewer: e.target.checked }),
                  )
                }
              />
              Written
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={column.visibleToFirstRoundReviewer ?? false}
                disabled={pending || !column.effectiveIncluded}
                onChange={(e) =>
                  run(() =>
                    updateField(instanceId, column.id, {
                      visibleToFirstRoundReviewer: e.target.checked,
                    }),
                  )
                }
              />
              1st round
            </label>
          </>
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

      <Error message={error} />
    </div>
  );
}
