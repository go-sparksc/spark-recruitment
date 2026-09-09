// PRD decision 115's prerequisite chain.
//
// Worth testing rather than eyeballing for one reason: the rule is enforced on
// three call sites in a `"use server"` module that no test can import, so before
// this moved into lib/ the only way to know it was right was to click it — and
// two of its three surfaces are behind the admin password.

import { describe, expect, it } from "vitest";

import { Round } from "@/generated/prisma/enums";
import { prerequisiteBlock } from "@/lib/rounds";

describe("prerequisiteBlock", () => {
  it("lets anyone into the written round", () => {
    // Where everyone enters. A reviewer with no rounds at all is the normal case
    // here — they are being created.
    expect(prerequisiteBlock([], Round.WRITTEN)).toBeNull();
  });

  it("lets a written reviewer into the first round", () => {
    expect(prerequisiteBlock([Round.WRITTEN], Round.FIRST_ROUND)).toBeNull();
  });

  it("lets a written and first-round reviewer into the second", () => {
    expect(prerequisiteBlock([Round.WRITTEN, Round.FIRST_ROUND], Round.SECOND_ROUND)).toBeNull();
  });

  it("refuses the first round to someone who never served the written", () => {
    const message = prerequisiteBlock([], Round.FIRST_ROUND);
    expect(message).not.toBeNull();
    expect(message).toMatch(/first round only after the written round/);
  });

  it("refuses the second round to someone who only served the written", () => {
    const message = prerequisiteBlock([Round.WRITTEN], Round.SECOND_ROUND);
    expect(message).not.toBeNull();
    expect(message).toMatch(/second round only after the first round/);
  });

  /// **The ordering case, and the reason the message names one round rather than
  /// the list.** A reviewer holding nothing is missing both prerequisites for
  /// the second round, but the grid cannot add two at once — so telling an admin
  /// to "add them to the written and first rounds" would name something they
  /// cannot do. The fix named is the first missing one.
  it("names only the first missing round as the fix", () => {
    const message = prerequisiteBlock([], Round.SECOND_ROUND);
    expect(message).not.toBeNull();
    // Both are named as what is required...
    expect(message).toMatch(/the written round and the first round/);
    // ...but the instruction points at the written round alone.
    expect(message).toMatch(/Add them to the written round first\./);
    expect(message).not.toMatch(/Add them to the first round first\./);
  });

  /// Decision 115 is explicit that participation means roster membership, not
  /// submitted work — so this function is told nothing about scores or votes and
  /// cannot accidentally start caring. Pinned as a signature fact.
  it("decides on round membership alone", () => {
    // Same rounds, and there is no second argument that could carry activity.
    expect(prerequisiteBlock([Round.WRITTEN], Round.FIRST_ROUND)).toBeNull();
    expect(prerequisiteBlock.length).toBe(2);
  });

  /// **Answers "may they JOIN", and is never asked about a round already held.**
  /// `addRound` returns early on `rounds.includes(round)` before reaching this,
  /// so the caller owns that case. Asserted as the refusal it actually gives,
  /// rather than as a null it does not promise — an earlier version of this test
  /// expected null and was simply wrong about the contract.
  ///
  /// It matters because decision 115 records that a reviewer CAN end up holding
  /// a later round without an earlier one: withdrawing someone from the written
  /// round breaks the chain from behind, and the rule is enforced on the way in
  /// rather than held as an invariant. Such a row keeps its rounds; nothing here
  /// retroactively strips it.
  it("would refuse a round whose prerequisites are missing, even one already held", () => {
    expect(prerequisiteBlock([Round.SECOND_ROUND], Round.SECOND_ROUND)).not.toBeNull();
  });

  it("is order-insensitive about the rounds it is given", () => {
    expect(prerequisiteBlock([Round.FIRST_ROUND, Round.WRITTEN], Round.SECOND_ROUND)).toBeNull();
  });
});
