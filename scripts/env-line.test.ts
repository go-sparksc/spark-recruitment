import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnvConfig } from "@next/env";
import { describe, expect, it } from "vitest";

import { envLine } from "./env-line";

// The contract is not "escape dollar signs" — it is "a line this prints, pasted
// into .env, arrives at the app byte-identical". Only Next's own loader can
// answer that, so the test uses it rather than reimplementing the rules. Bare
// `dotenv.parse` is NOT a valid stand-in: it leaves `\$` alone, and dotenv-expand
// running afterwards is what unescapes it.

/// Shaped exactly like a real argon2id digest: five `$`-delimited fields, and a
/// hash segment containing `+` and `/` from base64. Not a real password's hash.
const DIGEST =
  "$argon2id$v=19$m=19456,t=2,p=1$AQGL8VXOrsklVAcSuKT91w$LWVal5Gtsm7RYJqCJ2vV/p33TGEvQtOo8uDmqAECTXY";

/// Write one line to a throwaway .env and read it back the way the app does.
function throughNextLoader(line: string, name: string): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "env-line-"));
  writeFileSync(join(dir, ".env"), `${line}\n`, "utf8");

  delete process.env[name];
  // forceReload, since @next/env caches per process and this runs more than once.
  loadEnvConfig(dir, true, { info: () => {}, error: () => {} }, true);

  return process.env[name];
}

describe("envLine", () => {
  it("round-trips an argon2id digest through Next's env loader", () => {
    // The assertion the whole module exists for. If this fails, sign-in fails
    // with an error that names neither this file nor .env.
    expect(throughNextLoader(envLine("ADMIN_PASSWORD_HASH", DIGEST), "ADMIN_PASSWORD_HASH")).toBe(
      DIGEST,
    );
  });

  it("escapes each dollar sign exactly once", () => {
    // Both failure directions in one assertion. `JSON.stringify` produced the
    // doubled form, which survives the loader as a literal backslash and fails
    // argon2; no escaping at all lets dotenv-expand eat the fields.
    const line = envLine("ADMIN_PASSWORD_HASH", DIGEST);

    expect(line).toContain('="\\$argon2id\\$v=19\\$');
    expect(line).not.toContain("\\\\$");
  });

  it("survives a value with no dollar signs", () => {
    // SESSION_SECRET is base64url and never contains one. It must not be
    // mangled by a rule written for the other secret.
    const secret = "8-sfw_b2A4iYxofnJwJyWVpEly8L1qUja5ihJJ2UFvI";

    expect(throughNextLoader(envLine("SESSION_SECRET", secret), "SESSION_SECRET")).toBe(secret);
  });

  it("does not expand something that looks like a variable reference", () => {
    // The reason the escaping exists at all, stated as a test: unescaped, this
    // value would come back with $HOME replaced or emptied.
    const value = "literal-$HOME-and-$argon2-and-${BRACED}";

    expect(throughNextLoader(envLine("SPARK_TEST_VALUE", value), "SPARK_TEST_VALUE")).toBe(value);
  });
});
