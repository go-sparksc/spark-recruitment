import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decodeSession,
  encodeSession,
  newSession,
  safeRedirect,
  withInstance,
  type SessionPayload,
} from "@/lib/session";

const SECRET = "test-secret-not-used-anywhere-real";
const NOW = 1_700_000_000;

const session = (overrides: Partial<SessionPayload> = {}): SessionPayload => ({
  adm: true,
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
      '{"adm":"yes","ins":[],"exp":9999999999}', // adm not a boolean
      '{"adm":true,"exp":9999999999}', // ins missing
      '{"adm":true,"ins":[1],"exp":9999999999}', // ins not all strings
      '{"adm":true,"ins":[],"exp":"soon"}', // exp not a number
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

describe("newSession and withInstance", () => {
  it("starts admin-cleared with no instances unlocked", () => {
    const fresh = newSession(NOW);
    expect(fresh.adm).toBe(true);
    expect(fresh.ins).toEqual([]);
    expect(fresh.exp).toBeGreaterThan(NOW);
  });

  it("adds an instance without moving the expiry", () => {
    // Absolute expiry from sign-in: unlocking instances must not extend a
    // session indefinitely.
    const fresh = newSession(NOW);
    const unlocked = withInstance(fresh, "inst_a");

    expect(unlocked.ins).toEqual(["inst_a"]);
    expect(unlocked.exp).toBe(fresh.exp);
  });

  it("is idempotent", () => {
    const once = withInstance(newSession(NOW), "inst_a");
    expect(withInstance(once, "inst_a").ins).toEqual(["inst_a"]);
  });

  it("does not mutate the input", () => {
    const fresh = newSession(NOW);
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
