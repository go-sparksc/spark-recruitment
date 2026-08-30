import { describe, expect, it } from "vitest";

import {
  actorLabel,
  auditActor,
  auditPageWindow,
  humanizeAction,
  SYSTEM_ACTOR,
} from "@/lib/audit";
import type { SessionPayload } from "@/lib/session";

const session = (name: string): SessionPayload => ({
  adm: true,
  nm: name,
  ins: [],
  exp: 1_700_000_000,
});

describe("auditActor", () => {
  it("keeps actor as the role and puts the name beside it", () => {
    // Decision 93. Writing the name INTO actor would make the column untyped,
    // and would put names in the same column as "system".
    expect(auditActor(session("Ada Lovelace"))).toEqual({
      actor: "admin",
      actorName: "Ada Lovelace",
    });
  });

  it("never produces the shape SYSTEM_ACTOR produces", () => {
    // A person and the limiter must stay distinguishable in the table.
    expect(auditActor(session("Ada Lovelace")).actor).not.toBe(SYSTEM_ACTOR.actor);
    expect(SYSTEM_ACTOR.actorName).toBeNull();
  });
});

describe("actorLabel", () => {
  it("uses the name when there is one", () => {
    expect(actorLabel({ actor: "admin", actorName: "Ada Lovelace" })).toBe("Ada Lovelace");
  });

  it("does not invent a person for a system row", () => {
    // The one thing an attribution table must never do. A lockout was written
    // by the limiter; rendering it as "an admin" would name a human for
    // something no human did.
    expect(actorLabel(SYSTEM_ACTOR)).toBe("The system");
  });

  it("says a pre-Phase-8 row has no recorded name, rather than hiding it", () => {
    // These rows mean something specific: the action predates the name prompt.
    // "Unknown" would read as data loss; this reads as history.
    expect(actorLabel({ actor: "admin", actorName: null })).toBe(
      "An admin (before names were recorded)",
    );
  });

  it("treats a blank name as no name", () => {
    // adminDisplayName cannot produce one, but a hand-written row or a restored
    // export could, and a blank cell in the Who column reads as a rendering bug.
    expect(actorLabel({ actor: "admin", actorName: "   " })).toBe(
      "An admin (before names were recorded)",
    );
  });
});

describe("humanizeAction", () => {
  it("reads a SCREAMING_SNAKE action as a sentence", () => {
    expect(humanizeAction("RESET_INSTANCE_PASSWORD")).toBe("Reset instance password");
    expect(humanizeAction("DELETE_INSTANCE")).toBe("Delete instance");
    expect(humanizeAction("RATE_LIMIT_LOCKOUT")).toBe("Rate limit lockout");
  });

  it("handles a single word", () => {
    expect(humanizeAction("REGENERATE")).toBe("Regenerate");
  });

  it("does not mangle an unexpected shape", () => {
    // Actions are not a closed set, so this has to degrade rather than throw.
    expect(humanizeAction("")).toBe("");
    expect(humanizeAction("___")).toBe("___");
  });
});

describe("auditPageWindow", () => {
  it("describes the first page of a full log", () => {
    expect(auditPageWindow(120, 1, 50)).toEqual({
      skip: 0,
      take: 50,
      page: 1,
      pageCount: 3,
      hasPrevious: false,
      hasNext: true,
    });
  });

  it("describes the last page", () => {
    expect(auditPageWindow(120, 3, 50)).toMatchObject({
      skip: 100,
      page: 3,
      hasPrevious: true,
      hasNext: false,
    });
  });

  it("clamps a page past the end rather than returning an empty window", () => {
    // Someone edits ?page= in the address bar. Landing on the last real page
    // beats a blank table that looks like the log was purged.
    expect(auditPageWindow(120, 999, 50)).toMatchObject({ page: 3, skip: 100 });
  });

  it("clamps zero and negatives, which would otherwise be a negative skip", () => {
    // Prisma errors on a negative skip rather than returning nothing, so this
    // is a crash the URL bar can cause, not just a cosmetic problem.
    expect(auditPageWindow(120, 0, 50)).toMatchObject({ page: 1, skip: 0 });
    expect(auditPageWindow(120, -3, 50)).toMatchObject({ page: 1, skip: 0 });
  });

  it("survives a non-numeric page", () => {
    expect(auditPageWindow(120, Number.NaN, 50)).toMatchObject({ page: 1, skip: 0 });
  });

  it("reports one page for an empty log, not zero", () => {
    // A zero pageCount would make "Page 1 of 0" and clamp the page to 0.
    expect(auditPageWindow(0, 1, 50)).toEqual({
      skip: 0,
      take: 50,
      page: 1,
      pageCount: 1,
      hasPrevious: false,
      hasNext: false,
    });
  });

  it("does not offer a next page when the log fits exactly", () => {
    expect(auditPageWindow(50, 1, 50)).toMatchObject({ pageCount: 1, hasNext: false });
  });
});
