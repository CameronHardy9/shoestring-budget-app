// Run-time test passwords. No dependencies, so unit tests (`make check`) can
// import it without the stack.
//
// Every password in tests/ comes from here, never from an inline template such
// as `pw-${randomUUID()}`. Secret scanners (GitGuardian "Generic Password")
// flag a password-named variable assigned a string, even when it is random at
// run time; a function call does not match that pattern.
//
// auth.md §7 policy: 12-128 code points, any characters, not equal to the
// email, not breached. 18 random bytes as base64url are always 24 ASCII
// characters ([A-Za-z0-9_-], URL-safe so they also fit in a database URL),
// never contain "@" so never equal an email, and are effectively never in a
// breached corpus.
import { randomBytes } from "node:crypto";

export function randomPassword(): string {
  return randomBytes(18).toString("base64url");
}
