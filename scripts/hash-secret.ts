// Generate the values .env needs, so nobody has to improvise them.
//
//   npm run hash-secret                 -> a SESSION_SECRET and nothing else
//   npm run hash-secret -- "a password" -> that password's argon2id digest too
//
// The plaintext is echoed back once, deliberately: an admin who cannot see what
// they set cannot share it with the other co-presidents. It is never written
// anywhere. PRD §8 forbids storing or logging it, not printing it to the
// terminal of the person who just typed it.

import { randomBytes } from "node:crypto";

import { hashSecret } from "../lib/password";

async function main() {
  const password = process.argv[2];

  console.log("");
  console.log("SESSION_SECRET=" + randomBytes(32).toString("base64url"));

  if (!password) {
    console.log("");
    console.log("To generate ADMIN_PASSWORD_HASH as well, pass the password:");
    console.log('  npm run hash-secret -- "your chosen password"');
    console.log("");
    console.log("Choose a strong one. The attempt limiter in lib/rate-limit.ts");
    console.log("slows a brute-force attempt; it does not make a weak password safe.");
    console.log("");
    return;
  }

  // Next expands $VAR references inside .env files, and an argon2id digest is
  // five $-delimited fields — unescaped, it arrives at the app mangled and
  // argon2 rejects it with "password hash string missing field", which reads
  // like a corrupted secret rather than a quoting problem. Emit it ready to
  // paste. See Next's environment-variables guide: "If you need to use variable
  // with a `$` in the actual value, it needs to be escaped e.g. `\$`."
  const digest = await hashSecret(password);
  console.log("ADMIN_PASSWORD_HASH=" + JSON.stringify(digest.replaceAll("$", "\\$")));
  console.log("");
  console.log(`  password: ${password}`);
  console.log("  Share it with the other admins however you share the Slack code.");
  console.log("  It is not stored anywhere but this line and the hash above.");
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
