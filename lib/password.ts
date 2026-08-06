import { hash, verify } from "@node-rs/argon2";

// @node-rs/argon2 declares Algorithm as an ambient `const enum`, which cannot be
// imported as a value under isolatedModules. Argon2id is 2, and is also the
// library's default — but a security parameter should be stated, not inherited.
const ARGON2ID = 2;

// PRD section 8: passwords and reviewer access codes are hashed with argon2id.
// Never logged, never returned by an API, never displayed. Parameters live here
// so there is exactly one place to change them.
const ARGON2ID_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456, // 19 MiB — OWASP's argon2id baseline
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashSecret(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2ID_OPTIONS);
}

export function verifySecret(digest: string, plaintext: string): Promise<boolean> {
  return verify(digest, plaintext, ARGON2ID_OPTIONS);
}
