import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { Round } from "@/generated/prisma/enums";
import {
  decodeReviewerSession,
  encodeReviewerSession,
  newReviewerSession,
  REVIEWER_SESSION_TTL_SECONDS,
  type ReviewerSessionPayload,
} from "@/lib/reviewer-session";
import { encodeSession, newSession } from "@/lib/session";

const SECRET = "test-secret-not-used-anywhere-real";
const NOW = 1_700_000_000;
const INSTANCE = "inst_a";

const payload = (overrides: Partial<ReviewerSessionPayload> = {}): ReviewerSessionPayload => ({
  ins: INSTANCE,
  rd: Round.WRITTEN,
  rev: "rev_1",
  exp: NOW + 3600,
  ...overrides,
});

/// Sign an arbitrary JSON string correctly, so the signature check passes and
/// only the structural check can reject it. Signing with a bad signature instead
/// would make a test pass for the wrong reason and never exercise the shape
/// validation at all.
function signedAs(json: string): string {
  const encoded = Buffer.from(json).toString("base64url");
  return `${encoded}.${createHmac("sha256", SECRET).update(encoded).digest("base64url")}`;
}

describe("encode/decode round trip", () => {
  it("survives a round trip", () => {
    const original = payload();
    expect(decodeReviewerSession(encodeReviewerSession(original, SECRET), SECRET, INSTANCE, NOW))
      .toEqual(original);
  });

  it("rejects a token signed with a different secret", () => {
    // Rotating SESSION_SECRET invalidates admin and reviewer sessions together,
    // which is the point of signing both with it.
    const token = encodeReviewerSession(payload(), SECRET);
    expect(decodeReviewerSession(token, "a-different-secret", INSTANCE, NOW)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    // Swapping in another reviewer's id without the secret must not work. This
    // is the whole reason the name dropdown is not sufficient on its own.
    const token = encodeReviewerSession(payload({ rev: "rev_1" }), SECRET);
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify(payload({ rev: "rev_99" }))).toString("base64url");

    expect(decodeReviewerSession(`${forged}.${signature}`, SECRET, INSTANCE, NOW)).toBeNull();
  });

  it("rejects an expired session", () => {
    const token = encodeReviewerSession(payload({ exp: NOW }), SECRET);
    expect(decodeReviewerSession(token, SECRET, INSTANCE, NOW)).toBeNull();
    expect(decodeReviewerSession(token, SECRET, INSTANCE, NOW - 1)).toEqual(payload({ exp: NOW }));
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [undefined, "", "no-dot", "a.b.c", "!!!.???", "."]) {
      expect(decodeReviewerSession(bad, SECRET, INSTANCE, NOW)).toBeNull();
    }
  });

  it("rejects a validly signed payload of the wrong shape", () => {
    const shapes = [
      '{"rd":"WRITTEN","rev":"r","exp":9999999999}', // ins missing
      '{"ins":"","rd":"WRITTEN","rev":"r","exp":9999999999}', // ins blank
      '{"ins":"inst_a","rev":"r","exp":9999999999}', // rd missing
      '{"ins":"inst_a","rd":"SOMETHING","rev":"r","exp":9999999999}', // rd not a Round
      '{"ins":"inst_a","rd":"WRITTEN","exp":9999999999}', // rev missing
      '{"ins":"inst_a","rd":"WRITTEN","rev":"","exp":9999999999}', // rev blank
      '{"ins":"inst_a","rd":"WRITTEN","rev":"r","exp":"soon"}', // exp not a number
      "[]",
      "null",
      '"a string"',
    ];

    // Guard: prove a well-formed token really does decode, so the failures below
    // are the shape check doing its job rather than the signature check.
    expect(
      decodeReviewerSession(signedAs(JSON.stringify(payload())), SECRET, INSTANCE, NOW),
    ).not.toBeNull();

    for (const shape of shapes) {
      expect(decodeReviewerSession(signedAs(shape), SECRET, INSTANCE, NOW)).toBeNull();
    }
  });
});

describe("instance scoping", () => {
  it("refuses a valid session issued for a different instance", () => {
    // A reviewer on one cycle is not a reviewer on the next. Changing the id in
    // the URL must not carry the session across.
    const token = encodeReviewerSession(payload({ ins: "inst_a" }), SECRET);

    expect(decodeReviewerSession(token, SECRET, "inst_a", NOW)).not.toBeNull();
    expect(decodeReviewerSession(token, SECRET, "inst_b", NOW)).toBeNull();
  });

  it("makes the instance check impossible to forget", () => {
    // The comparison is an argument to decoding rather than something a caller
    // does afterwards, so a page that reads the session cannot skip it. This
    // asserts the signature shape, not behaviour: decodeReviewerSession takes
    // the instance id, so omitting it does not typecheck.
    expect(decodeReviewerSession.length).toBe(4);
  });
});

describe("the reviewer cookie and the admin cookie do not cross", () => {
  it("refuses an admin session token", () => {
    // Both are signed with SESSION_SECRET, so the signature check passes and the
    // shape check is the only thing standing between an admin cookie pasted into
    // the reviewer slot and a valid reviewer session. It must reject.
    const adminToken = encodeSession(newSession(NOW), SECRET);

    expect(decodeReviewerSession(adminToken, SECRET, INSTANCE, NOW)).toBeNull();
  });

  it("refuses an admin session that has unlocked this very instance", () => {
    // The closest thing to a real confusion: a signed admin token naming this
    // instance in `ins`. It is an array there and a string here, and it carries
    // no reviewer id, so there is no reading under which it becomes a reviewer.
    const adminToken = encodeSession({ adm: true, ins: [INSTANCE], exp: NOW + 3600 }, SECRET);

    expect(decodeReviewerSession(adminToken, SECRET, INSTANCE, NOW)).toBeNull();
  });
});

describe("newReviewerSession", () => {
  it("carries the instance, round and reviewer it was issued for", () => {
    const fresh = newReviewerSession(INSTANCE, Round.WRITTEN, "rev_1", NOW);

    expect(fresh.ins).toBe(INSTANCE);
    expect(fresh.rd).toBe(Round.WRITTEN);
    expect(fresh.rev).toBe("rev_1");
  });

  it("expires a week out, so it covers a written round without outliving it", () => {
    expect(newReviewerSession(INSTANCE, Round.WRITTEN, "rev_1", NOW).exp).toBe(
      NOW + REVIEWER_SESSION_TTL_SECONDS,
    );
    expect(REVIEWER_SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("issues distinct sessions per round for the same person", () => {
    // A reviewer serving two rounds signs in twice, with two codes. The rounds
    // have different field visibility under §6, so one session must not answer
    // for the other.
    const written = newReviewerSession(INSTANCE, Round.WRITTEN, "rev_1", NOW);
    const second = newReviewerSession(INSTANCE, Round.SECOND_ROUND, "rev_1", NOW);

    expect(written.rd).not.toBe(second.rd);
  });
});
