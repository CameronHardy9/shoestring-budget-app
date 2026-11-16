// Real sign-in paths for the suites that test authentication itself. Other
// tests use the faster test login (hooks.testLogin).
import { expect } from "vitest";
import type { TestUser } from "./factories.ts";
import { createUser } from "./factories.ts";
import { ApiClient, codeOf } from "./http.ts";
import { advanceClock, now, testLogin } from "./hooks.ts";
import { totp } from "./totp.ts";

export const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** POST /auth/login with the factory password. */
export async function passwordLogin(
  user: TestUser,
  label?: string,
): Promise<{ client: ApiClient; state: string }> {
  const client = new ApiClient(label ?? user.email.split("@")[0]);
  const res = await client.post<{ state: string }>(
    "/auth/login",
    { email: user.email, password: user.password },
    { headers: { "user-agent": CHROME_UA } },
  );
  expect(res.status, res.describe).toBe(200);
  return { client, state: res.body.state };
}

/** Password sign-in for a user without MFA. */
export async function signIn(
  user: TestUser,
  label?: string,
): Promise<ApiClient> {
  const { client, state } = await passwordLogin(user, label);
  expect(state).toBe("authenticated");
  return client;
}

/** Moves the clock to the next TOTP step, so the next code is not a replay. */
export async function nextTotpStep(): Promise<void> {
  await advanceClock(30_000);
}

export interface TotpEnrollment {
  secret: string;
  recoveryCodes: string[];
}

/**
 * TOTP enrollment through the API (POST /me/mfa/totp, then confirm with a code
 * computed here), as the user does it. Needs a fresh re-auth window (any
 * sign-in gives one). Leaves the clock one TOTP step later.
 */
export async function enrollTotp(client: ApiClient): Promise<TotpEnrollment> {
  const setup = await client.post<{ secret: string; otpauthUri: string }>(
    "/me/mfa/totp",
  );
  expect(setup.status, setup.describe).toBe(201);
  const confirm = await client.post<{ recoveryCodes: string[] | null }>(
    "/me/mfa/totp/confirm",
    {
      code: totp(setup.body.secret, now()),
    },
  );
  expect(confirm.status, confirm.describe).toBe(200);
  expect(confirm.body.recoveryCodes).toHaveLength(10);
  await nextTotpStep();
  return {
    secret: setup.body.secret,
    recoveryCodes: confirm.body.recoveryCodes!,
  };
}

export interface MfaUser extends TestUser, TotpEnrollment {}

/** A factory user with TOTP enrolled through the API. */
export async function createUserWithTotp(
  opts: { prefix?: string } = {},
): Promise<MfaUser> {
  const user = await createUser({ prefix: opts.prefix ?? "mfa" });
  const client = await testLogin(user.email);
  const enrolled = await enrollTotp(client);
  return { ...user, ...enrolled };
}

/** Password, then the `mfa_pending` session (no factor yet). */
export async function startMfaSignIn(
  user: TestUser,
  label?: string,
): Promise<ApiClient> {
  const { client, state } = await passwordLogin(user, label);
  expect(state).toBe("mfa_required");
  return client;
}

/** Full MFA sign-in with a TOTP code computed here; leaves the clock one step later. */
export async function mfaSignIn(
  user: MfaUser,
  label?: string,
): Promise<ApiClient> {
  const client = await startMfaSignIn(user, label);
  const res = await client.post<{ state: string }>("/auth/mfa/verify", {
    method: "totp",
    code: totp(user.secret, now()),
  });
  expect(res.status, `${res.describe} ${codeOf(res) ?? ""}`).toBe(200);
  expect(res.body.state).toBe("authenticated");
  await nextTotpStep();
  return client;
}
