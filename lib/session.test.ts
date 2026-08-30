import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  adminDisplayName,
  decodeSession,
  encodeSession,
  MAX_ADMIN_NAME_LENGTH,
  newSession,
  safeRedirect,
  withInstance,
  type SessionPayload,
} from "@/lib/session";

const SECRET = "test-secret-not-used-anywhere-real";
const NOW = 1_700_000_000;

const session = (overrides: Partial<SessionPayload> = {}): SessionPayload => ({
  adm: true,
  nm: "Ada Lovelace",
  ins: [],
  exp: NOW + 3600,
  ...overrides,
});

describe("encode/decode round trip", () => {
  it("survives a round trip", () => {
    const original = session({ ins: ["inst_a", "inst_b"] });
    expect(decodeSession(encodeSession(original, SECRET), SECRET, NOW)).toEqual(original);
  });

  it("rejects a token signed with a different secret", () => {
    // This is the revocation mechanism: rotating SESSION_SECRET invalidates
    // every outstanding session at once.
    const token = encodeSession(session(), SECRET);
    expect(decodeSession(token, "a-different-secret", NOW)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    // The whole point. Flipping adm to true without the secret must not work.
    const token = encodeSession(session({ adm: false }), SECRET);
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify(session({ adm: true }))).toString("base64url");

    expect(decodeSession(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("rejects an expired session", () => {
    const token = encodeSession(session({ exp: NOW }), SECRET);
    expect(decodeSession(token, SECRET, NOW)).toBeNull();
    expect(decodeSession(token, SECRET, NOW - 1)).toEqual(session({ exp: NOW }));
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of [undefined, "", "no-dot", "a.b.c", "!!!.???", "."]) {
      expect(decodeSession(bad, SECRET, NOW)).toBeNull();
    }
  });

  it("rejects a VALIDLY SIGNED payload of the wrong shape", () => {
    // Each of these is signed correctly, so the signature check passes and the
    // structural check is the only thing that can reject them. Signing them with
    // a mismatched signature instead would make this test pass for the wrong
    // reason and never exercise the shape validation at all.
    const shapes = [
      '{"adm":"yes","nm":"A B","ins":[],"exp":9999999999}', // adm not a boolean
      '{"adm":true,"nm":"A B","exp":9999999999}', // ins missing
      '{"adm":true,"nm":"A B","ins":[1],"exp":9999999999}', // ins not all strings
      '{"adm":true,"nm":"A B","ins":[],"exp":"soon"}', // exp not a number
      // The Phase 8 additions. A session minted before the name prompt existed
      // is exactly the first of these, and it has to be refused rather than
      // defaulted — see the case below.
      '{"adm":true,"ins":[],"exp":9999999999}', // nm missing
      '{"adm":true,"nm":"","ins":[],"exp":9999999999}', // nm empty
      '{"adm":true,"nm":42,"ins":[],"exp":9999999999}', // nm not a string
      "[]",
      "null",
      '"a string"',
    ];

    for (const shape of shapes) {
      const encoded = Buffer.from(shape).toString("base64url");
      const signature = createHmac("sha256", SECRET).update(encoded).digest("base64url");

      // Guard: prove the signature really is valid, so a failure below is the
      // shape check doing its job rather than the signature check.
      const wellFormed = decodeSession(
        `${Buffer.from(JSON.stringify(session())).toString("base64url")}.${createHmac("sha256", SECRET).update(Buffer.from(JSON.stringify(session())).toString("base64url")).digest("base64url")}`,
        SECRET,
        NOW,
      );
      expect(wellFormed).not.toBeNull();

      expect(decodeSession(`${encoded}.${signature}`, SECRET, NOW)).toBeNull();
    }
  });
});

describe("a session minted before the name prompt existed", () => {
  it("is refused rather than defaulted, so no unattributed row can be written", () => {
    // The Phase 8 upgrade case, stated as its own test because the consequence
    // of getting it wrong is invisible: a cookie issued yesterday carries no
    // `nm`, and accepting it would let that admin keep writing audit rows with
    // no name on them for the remaining twelve hours of its life. Refusing
    // costs one sign-in, which is where the name is collected.
    const legacy = { adm: true, ins: ["inst_a"], exp: NOW + 3600 };
    const encoded = Buffer.from(JSON.stringify(legacy)).toString("base64url");
    const signature = createHmac("sha256", SECRET).update(encoded).digest("base64url");

    expect(decodeSession(`${encoded}.${signature}`, SECRET, NOW)).toBeNull();
  });
});

describe("adminDisplayName", () => {
  it("joins the two halves", () => {
    expect(adminDisplayName("Ada", "Lovelace")).toBe("Ada Lovelace");
  });

  it("trims and collapses whitespace", () => {
    expect(adminDisplayName("  Ada  ", "  Lovelace  ")).toBe("Ada Lovelace");
    expect(adminDisplayName("Ada\tGrace", "Lovelace")).toBe("Ada Grace Lovelace");
  });

  it("accepts one half alone", () => {
    // A mononym, or someone who only fills one box. Attribution to "Prince" is
    // worth more than refusing the sign-in.
    expect(adminDisplayName("Prince", "")).toBe("Prince");
    expect(adminDisplayName("", "Lovelace")).toBe("Lovelace");
  });

  it("returns null when there is nothing to attribute to", () => {
    // The caller turns this into a form error. Storing a blank signature would
    // be indistinguishable from a pre-Phase-8 row, which means something else.
    expect(adminDisplayName("", "")).toBeNull();
    expect(adminDisplayName("   ", "\t\n")).toBeNull();
  });

  it("truncates rather than refusing an over-long name", () => {
    // The audit table is not free storage for anyone holding the app password,
    // and a 4000-character "name" would also bloat every cookie it rides in.
    const long = adminDisplayName("x".repeat(200), "y".repeat(200));

    expect(long).toHaveLength(MAX_ADMIN_NAME_LENGTH);
  });
});

describe("newSession and withInstance", () => {
  it("starts admin-cleared with no instances unlocked", () => {
    const fresh = newSession("Ada Lovelace", NOW);
    expect(fresh.adm).toBe(true);
    expect(fresh.nm).toBe("Ada Lovelace");
    expect(fresh.ins).toEqual([]);
    expect(fresh.exp).toBeGreaterThan(NOW);
  });

  it("adds an instance without moving the expiry", () => {
    // Absolute expiry from sign-in: unlocking instances must not extend a
    // session indefinitely.
    const fresh = newSession("Ada Lovelace", NOW);
    const unlocked = withInstance(fresh, "inst_a");

    expect(unlocked.ins).toEqual(["inst_a"]);
    expect(unlocked.exp).toBe(fresh.exp);
  });

  it("is idempotent", () => {
    const once = withInstance(newSession("Ada Lovelace", NOW), "inst_a");
    expect(withInstance(once, "inst_a").ins).toEqual(["inst_a"]);
  });

  it("does not mutate the input", () => {
    const fresh = newSession("Ada Lovelace", NOW);
    withInstance(fresh, "inst_a");
    expect(fresh.ins).toEqual([]);
  });
});

describe("safeRedirect", () => {
  it("allows a path on this origin", () => {
    expect(safeRedirect("/instances/abc/mapping")).toBe("/instances/abc/mapping");
  });

  it("refuses absolute URLs and protocol-relative paths", () => {
    // "//evil.example" is the one that gets missed: it looks relative.
    expect(safeRedirect("//evil.example")).toBe("/");
    expect(safeRedirect("https://evil.example")).toBe("/");
    expect(safeRedirect("http://evil.example")).toBe("/");
    expect(safeRedirect("/\\evil.example")).toBe("/");
  });

  it("falls back when absent", () => {
    expect(safeRedirect(null)).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
    expect(safeRedirect("")).toBe("/");
  });
});
