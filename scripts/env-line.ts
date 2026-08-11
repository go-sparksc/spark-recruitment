// Formatting one `.env` line, with the dollar-sign escaping Next's loader
// expects. Its own module so the test can import it without running
// hash-secret.ts, which generates a secret and prints at module load.
//
// The escaping is a real contract with a silent failure mode, which is why it
// is worth a test rather than an inline `.replaceAll`. An argon2id digest is
// five `$`-delimited fields. Next loads `.env` through `@next/env`, which runs
// dotenv and then dotenv-expand; dotenv-expand is what treats `\$` as a literal
// dollar rather than the start of a `$VAR` reference. Get it wrong in either
// direction and the app receives a mangled digest and argon2 reports "password
// hash string missing field", which reads like a corrupted secret rather than a
// quoting problem and sends whoever hits it looking in the wrong place.
//
// Wrong in both directions has now happened. Too few backslashes and the digest
// is expanded away; too many — which is what `JSON.stringify` produced, since it
// escapes the backslashes it finds — and a literal `\$` survives into the value.
//
// Note that this applies to `.env` files only. A value pasted into a hosting
// dashboard is not expanded and must NOT be escaped.
export function envLine(name: string, value: string): string {
  return `${name}="${value.replaceAll("$", "\\$")}"`;
}
