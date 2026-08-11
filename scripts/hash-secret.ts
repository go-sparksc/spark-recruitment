// Generate the values .env needs, so nobody has to improvise them.
//
//   npm run hash-secret                 -> a SESSION_SECRET and nothing else
//   npm run hash-secret -- "a password" -> that password's argon2id digest too
//
// The plaintext is echoed back once, deliberately: an admin who cannot see what
// they set cannot share it with the other co-presidents, and it is the string
// they will actually type at sign-in. It is never written anywhere. PRD §8
// forbids storing or logging it, not printing it to the terminal of the person
// who just typed it.
//
// The output is fenced into a block meant for .env and a block that must not go
// near it, because the first version of this script printed all three lines
// alike and the obvious thing to do with them — select all, paste — put the
// plaintext password into .env underneath its own hash. It parsed as nothing
// and broke nothing, so there was no error to follow; it just sat there while
// the admin typed a different password and got "Incorrect password." Anything
// this script prints will be pasted somewhere, so it says where.

import { randomBytes } from "node:crypto";

import { envLine } from "./env-line";
import { hashSecret } from "../lib/password";

// ASCII only. This runs in whatever terminal the admin has, and a mojibake rule
// line in the one place they are being asked to copy exactly is a bad trade for
// a prettier dash.
const RULE = "-".repeat(72);

function fence(title: string): void {
  console.log("");
  console.log(`${RULE}`);
  console.log(`  ${title}`);
  console.log(`${RULE}`);
  console.log("");
}

async function main() {
  const password = process.argv[2];
  const sessionSecret = envLine("SESSION_SECRET", randomBytes(32).toString("base64url"));

  if (!password) {
    fence("COPY INTO .env");
    console.log(sessionSecret);
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
  // Escaping lives in ./env-line, which is tested against Next's own loader.
  // It used to be an inline JSON.stringify here, which was wrong: it escapes the
  // backslashes it finds, so a digest already carrying \$ printed as \\$ and a
  // literal backslash survived into the value. The failure that produces is the
  // same unreadable "password hash string missing field" that the escaping
  // exists to prevent.
  const digest = await hashSecret(password);

  fence("COPY THESE TWO LINES INTO .env");
  console.log(sessionSecret);
  console.log(envLine("ADMIN_PASSWORD_HASH", digest));
  console.log("");
  console.log("  Every $ above is escaped as \\$ on purpose — Next expands $VAR");
  console.log("  inside .env files. Paste the lines exactly as printed.");
  console.log("");
  console.log("  Replacing SESSION_SECRET signs out every existing session. Keep");
  console.log("  your current one if you only meant to change the password.");

  fence("DO NOT PUT THIS IN .env - it is the password you type at sign-in");
  console.log(`  ${password}`);
  console.log("");
  console.log("  This exact string is what the hash above was made from, spaces");
  console.log("  and capitals included. Type it, do not retype what you meant to");
  console.log("  type — if the two differ, the one printed here is the one that");
  console.log("  works.");
  console.log("");
  console.log("  Share it with the other admins however you share the Slack code.");
  console.log("  It is stored nowhere: not in .env, not in the database, not in");
  console.log("  this script. Lose it and you run this again.");
  console.log("");
  console.log("  If you paste it into .env by accident, delete the line. It parses");
  console.log("  as nothing, so nothing will complain, and your password will sit");
  console.log("  in a file next to its own hash.");
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
