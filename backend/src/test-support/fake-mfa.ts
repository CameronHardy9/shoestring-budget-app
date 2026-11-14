// In-memory stand-in for dal.mfa, following the DAL's documented semantics
// (single-use challenges, replay-protected TOTP steps, recovery codes only on
// the first factor, MFA_NOT_ENABLED / NOT_FOUND / LIMIT_REACHED).
import { DalError } from "@shoestring/db";
import type {
  ChallengeBinding,
  MfaSummaryRecord,
  PasskeyCredential,
  RecoveryCodeHashes,
} from "@shoestring/db";
import type { AppClock } from "../clock.ts";

interface Totp {
  keyId: string;
  ciphertext: Buffer;
  confirmed: boolean;
  lastUsedStep: number | null;
  createdAt: number;
}

export class FakeMfa {
  readonly totp = new Map<string, Totp>();
  readonly passkeys = new Map<
    string,
    (PasskeyCredential & { userId: string; name: string; createdAt: Date })[]
  >();
  readonly codes = new Map<
    string,
    { id: string; keyId: string; codeHash: Buffer; used: boolean }[]
  >();
  readonly challenges = new Map<
    string,
    { userId: string; purpose: string; challenge: Buffer; expiresAt: number }
  >();
  private readonly clock: AppClock;
  constructor(clock: AppClock) {
    this.clock = clock;
  }

  private factors(userId: string) {
    return {
      totp: this.totp.get(userId)?.confirmed === true,
      passkeys: (this.passkeys.get(userId) ?? []).length,
    };
  }

  private setCodes(userId: string, c: RecoveryCodeHashes) {
    this.codes.set(
      userId,
      c.hashes.map((h) => ({
        id: crypto.randomUUID(),
        keyId: c.keyId,
        codeHash: h,
        used: false,
      })),
    );
  }

  dal() {
    const now = () => this.clock.now().getTime();
    const bindKey = (b: ChallengeBinding) => b.sessionId ?? b.userTokenId ?? "";
    return {
      getMfaSummary: (userId: string): Promise<MfaSummaryRecord> => {
        const f = this.factors(userId);
        return Promise.resolve({
          enabled: f.totp || f.passkeys > 0,
          totp: f.totp,
          passkeyCount: f.passkeys,
          recoveryCodesRemaining: (this.codes.get(userId) ?? []).filter(
            (c) => !c.used,
          ).length,
        });
      },
      getMfaDetail: async (userId: string) => ({
        ...(await this.dal().getMfaSummary(userId)),
        passkeys: (this.passkeys.get(userId) ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          createdAt: p.createdAt,
          lastUsedAt: null,
        })),
      }),
      beginTotpSetup: (
        userId: string,
        s: { keyId: string; ciphertext: Buffer },
      ) => {
        if (this.totp.get(userId)?.confirmed)
          return Promise.reject(new DalError("ALREADY_EXISTS"));
        this.totp.set(userId, {
          ...s,
          confirmed: false,
          lastUsedStep: null,
          createdAt: now(),
        });
        return Promise.resolve();
      },
      getTotpSecret: (userId: string, which: "confirmed" | "pending_setup") => {
        const t = this.totp.get(userId);
        const ok =
          t &&
          (which === "confirmed"
            ? t.confirmed
            : !t.confirmed && t.createdAt > now() - 15 * 60_000);
        return Promise.resolve(
          ok
            ? {
                keyId: t.keyId,
                ciphertext: t.ciphertext,
                confirmed: t.confirmed,
                lastUsedStep: t.lastUsedStep,
              }
            : null,
        );
      },
      confirmTotpSetup: (
        userId: string,
        input: { step: number; recoveryCodes: RecoveryCodeHashes },
      ) => {
        const t = this.totp.get(userId);
        if (!t || t.confirmed) return Promise.reject(new DalError("NOT_FOUND"));
        const f = this.factors(userId);
        const first = !f.totp && f.passkeys === 0;
        t.confirmed = true;
        t.lastUsedStep = input.step;
        if (first) this.setCodes(userId, input.recoveryCodes);
        return Promise.resolve({ recoveryCodesCreated: first });
      },
      useTotpStep: (userId: string, step: number) => {
        const t = this.totp.get(userId);
        if (
          !t?.confirmed ||
          (t.lastUsedStep !== null && step <= t.lastUsedStep)
        )
          return Promise.resolve(false);
        t.lastUsedStep = step;
        return Promise.resolve(true);
      },
      removeTotp: (userId: string) => {
        if (!this.totp.get(userId)?.confirmed)
          return Promise.reject(new DalError("NOT_FOUND"));
        this.totp.delete(userId);
        const f = this.factors(userId);
        const disabled = !f.totp && f.passkeys === 0;
        if (disabled) this.codes.delete(userId);
        return Promise.resolve({ mfaDisabled: disabled });
      },
      listPasskeyCredentials: (userId: string) =>
        Promise.resolve(
          (this.passkeys.get(userId) ?? []).map((p) => ({ ...p })),
        ),
      countPasskeys: (userId: string) =>
        Promise.resolve(this.factors(userId).passkeys),
      addPasskey: (
        userId: string,
        input: {
          credentialId: Buffer;
          publicKey: Buffer;
          signCount: number;
          transports: string[];
          name: string;
          recoveryCodes: RecoveryCodeHashes;
        },
      ) => {
        const list = this.passkeys.get(userId) ?? [];
        if (list.length >= 10)
          return Promise.reject(new DalError("LIMIT_REACHED"));
        if (list.some((p) => p.credentialId.equals(input.credentialId)))
          return Promise.reject(new DalError("ALREADY_EXISTS"));
        const f = this.factors(userId);
        const first = !f.totp && f.passkeys === 0;
        const id = crypto.randomUUID();
        list.push({
          id,
          userId,
          credentialId: input.credentialId,
          publicKey: input.publicKey,
          signCount: input.signCount,
          transports: input.transports,
          name: input.name,
          createdAt: this.clock.now(),
        });
        this.passkeys.set(userId, list);
        if (first) this.setCodes(userId, input.recoveryCodes);
        return Promise.resolve({ passkeyId: id, recoveryCodesCreated: first });
      },
      removePasskey: (userId: string, id: string) => {
        const list = this.passkeys.get(userId) ?? [];
        if (!list.some((p) => p.id === id))
          return Promise.reject(new DalError("NOT_FOUND"));
        this.passkeys.set(
          userId,
          list.filter((p) => p.id !== id),
        );
        const f = this.factors(userId);
        const disabled = !f.totp && f.passkeys === 0;
        if (disabled) this.codes.delete(userId);
        return Promise.resolve({ mfaDisabled: disabled });
      },
      recordPasskeyUse: (userId: string, id: string, signCount: number) => {
        const p = (this.passkeys.get(userId) ?? []).find((x) => x.id === id);
        if (p) p.signCount = signCount;
        return Promise.resolve();
      },
      createWebAuthnChallenge: (
        userId: string,
        b: ChallengeBinding,
        challenge: Buffer,
      ) => {
        this.challenges.set(bindKey(b), {
          userId,
          purpose: b.purpose,
          challenge,
          expiresAt: now() + 5 * 60_000,
        });
        return Promise.resolve();
      },
      consumeWebAuthnChallenge: (b: ChallengeBinding) => {
        const c = this.challenges.get(bindKey(b));
        this.challenges.delete(bindKey(b));
        return Promise.resolve(
          c && c.purpose === b.purpose && c.expiresAt > now()
            ? { userId: c.userId, challenge: c.challenge }
            : null,
        );
      },
      regenerateRecoveryCodes: (userId: string, c: RecoveryCodeHashes) => {
        const f = this.factors(userId);
        if (!f.totp && f.passkeys === 0)
          return Promise.reject(new DalError("MFA_NOT_ENABLED"));
        this.setCodes(userId, c);
        return Promise.resolve();
      },
      listUnusedRecoveryCodes: (userId: string) =>
        Promise.resolve(
          (this.codes.get(userId) ?? [])
            .filter((c) => !c.used)
            .map(({ id, keyId, codeHash }) => ({ id, keyId, codeHash })),
        ),
      useRecoveryCode: (userId: string, id: string) => {
        const c = (this.codes.get(userId) ?? []).find(
          (x) => x.id === id && !x.used,
        );
        if (c) c.used = true;
        return Promise.resolve(c !== undefined);
      },
    };
  }
}
