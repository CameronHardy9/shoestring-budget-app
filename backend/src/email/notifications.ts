// Notification emails (auth.md §15). Plain text, no financial data, links
// built only from APP_ORIGIN, user text escaped and capped (F-29).
import type { DeviceBrowser, DeviceOs } from "@shoestring/db";
import type { EmailKind, OutgoingEmail } from "./transports.ts";

/** SPA paths for links. The token links are contract-defined (auth.md §4); the rest are frontend routes. */
export const LINK_PATHS = {
  signin: "/signin",
  signup: "/signup",
  sessions: "/settings/sessions",
  invitations: "/invitations",
  budgets: "/budgets",
  deletedBudgets: "/settings/deleted-budgets",
  security: "/settings/security",
  resetPassword: "/reset-password",
  confirmEmail: "/confirm-email",
  cancelEmailChange: "/cancel-email-change",
} as const;

const SECURE_ADVICE =
  "If this was not you, reset your password and check your two-factor settings now";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** Bidi controls (F-48): rejected at input too (data-model.md "Text"); stripped here as a second layer. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** ASCII "." and the dot look-alikes URL parsers map to "." (U+3002, U+FF0E, U+FF61, U+FE52). */
const DOTS = /[.\u3002\uff0e\uff61\ufe52]/g;

/**
 * User-controlled text in plain-text mail (F-29, F-48): NFKC-normalized (so
 * full-width and compatibility forms become the ASCII they imitate), bidi
 * controls removed, no control characters or line breaks, capped at its
 * schema length, then defanged so no client can auto-link it. Replacements
 * are stable under NFKC and are not treated as separators by URL parsers:
 * "." and its look-alikes -> U+2E31, "/" -> U+2215, ":" -> U+02D0, "@" -> "(at)".
 */
export function safeUserText(value: string, max: number): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(BIDI, "")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned)
    .slice(0, max)
    .join("")
    .replace(DOTS, "\u2e31")
    .replace(/\//g, "\u2215")
    .replace(/:/g, "\u02d0")
    .replace(/@/g, "(at)");
}

const BROWSER_LABEL: Record<DeviceBrowser, string> = {
  safari: "Safari",
  chrome: "Chrome",
  firefox: "Firefox",
  edge: "Edge",
  samsung_internet: "Samsung Internet",
  other: "another browser",
  unknown: "an unknown browser",
};
const OS_LABEL: Record<DeviceOs, string> = {
  ios: "iOS",
  ipados: "iPadOS",
  android: "Android",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  chromeos: "ChromeOS",
  other: "another system",
  unknown: "an unknown system",
};

const FOOTER =
  "\n\nYou are receiving this because you have a Shoestring account. This is an automated message.";

export class Notifications {
  private readonly appOrigin: string;
  constructor(
    appOrigin: string,
  ) {
    this.appOrigin = appOrigin;
  }

  private link(path: string, fragment?: string): string {
    return `${this.appOrigin}${path}${fragment ?? ""}`;
  }

  private mail(
    to: string,
    kind: EmailKind,
    priority: boolean,
    subject: string,
    body: string,
    links: string[],
  ): OutgoingEmail {
    return { to, kind, priority, subject, text: `${body}${FOOTER}`, links };
  }

  signupInvite(to: string, token: string, expiresAt: Date): OutgoingEmail {
    const url = this.link(LINK_PATHS.signup, `#token=${token}`);
    return this.mail(
      to,
      "signup_invite",
      true,
      "You're invited to Shoestring",
      `You have been invited to create a Shoestring account.\n\nCreate your account: ${url}\n\nThis link expires on ${expiresAt.toISOString()} and works once. If you did not expect this, ignore this email.`,
      [url],
    );
  }

  newSignIn(to: string, device: { browser: DeviceBrowser; os: DeviceOs }, at: Date): OutgoingEmail {
    const url = this.link(LINK_PATHS.sessions);
    return this.mail(
      to,
      "new_sign_in",
      true,
      "New sign-in to your Shoestring account",
      `Someone signed in to your account using ${BROWSER_LABEL[device.browser]} on ${OS_LABEL[device.os]} at ${at.toISOString()}.\n\nIf this was you, there is nothing to do. If not, sign out the device and change your password: ${url}`,
      [url],
    );
  }

  loginThrottled(to: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.sessions);
    return this.mail(
      to,
      "login_throttled",
      true,
      "Repeated failed sign-ins to your Shoestring account",
      `There have been many failed sign-in attempts on your account in the last 24 hours, so sign-in is paused for a while. If this was not you, consider resetting your password and turning on two-factor authentication: ${url}`,
      [url],
    );
  }

  budgetInvitation(to: string, inviterName: string | null, budgetName: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.invitations);
    const who = inviterName ? safeUserText(inviterName, 50) : "A Shoestring user";
    return this.mail(
      to,
      "budget_invitation",
      false,
      "You're invited to a shared budget",
      `${who} invited you to the budget "${safeUserText(budgetName, 60)}".\n\nSign in to accept or decline: ${url}`,
      [url],
    );
  }

  invitationAccepted(to: string, memberName: string, budgetName: string, budgetId: string): OutgoingEmail {
    const url = this.link(`${LINK_PATHS.budgets}/${budgetId}/members`);
    return this.mail(
      to,
      "invitation_accepted",
      true,
      "Your budget invitation was accepted",
      `${safeUserText(memberName, 50)} joined your budget "${safeUserText(budgetName, 60)}" and can now see and edit it.\n\nIf you did not expect this, review the members: ${url}`,
      [url],
    );
  }

  budgetDeleted(to: string, budgetName: string, isOwner: boolean): OutgoingEmail {
    const url = this.link(LINK_PATHS.deletedBudgets);
    const tail = isOwner
      ? `You can restore it for 30 days: ${url}`
      : "The owner can restore it for 30 days.";
    return this.mail(
      to,
      "budget_deleted",
      true,
      "A shared budget was deleted",
      `The budget "${safeUserText(budgetName, 60)}" was deleted by its owner. ${tail}`,
      isOwner ? [url] : [],
    );
  }

  memberRemoved(to: string, budgetName: string): OutgoingEmail {
    return this.mail(
      to,
      "member_removed",
      true,
      "You were removed from a budget",
      `You were removed from the budget "${safeUserText(budgetName, 60)}" by its owner and can no longer see it.`,
      [],
    );
  }

  ownershipTransferred(to: string, budgetName: string, newOwnerName: string, budgetId: string): OutgoingEmail {
    const url = this.link(`${LINK_PATHS.budgets}/${budgetId}/members`);
    return this.mail(
      to,
      "ownership_transferred",
      true,
      "Budget ownership changed",
      `${safeUserText(newOwnerName, 50)} is now the owner of the budget "${safeUserText(budgetName, 60)}".\n\nReview the members: ${url}`,
      [url],
    );
  }

  // ---------------------------------------------------------------- Phase B
  mfaFailures(to: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.security);
    return this.mail(to, "mfa_failures", true, "Failed two-factor attempts on your Shoestring account",
      `Someone entered your password correctly but failed the two-factor check 5 times. ${SECURE_ADVICE}: ${url}`, [url]);
  }

  mfaLocked(to: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.security);
    return this.mail(to, "mfa_locked", true, "Two-factor checks paused on your Shoestring account",
      `Too many failed two-factor checks in the last 24 hours, so they are paused for a while. ${SECURE_ADVICE}: ${url}`, [url]);
  }

  passwordReset(to: string, token: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.resetPassword, `#token=${token}`);
    return this.mail(to, "password_reset", false, "Reset your Shoestring password",
      `Use this link within 30 minutes to choose a new password: ${url}\n\nIf you did not ask for this, ignore this email; your password is unchanged.`, [url]);
  }

  passwordChanged(to: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.security);
    return this.mail(to, "password_changed", true, "Your Shoestring password was changed",
      `Your password was changed and other devices were signed out. ${SECURE_ADVICE}: ${url}`, [url]);
  }

  emailChangeConfirm(to: string, token: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.confirmEmail, `#token=${token}`);
    return this.mail(to, "email_change_confirm", false, "Confirm your new Shoestring email address",
      `Confirm this address for your Shoestring account within 24 hours, signed in on the device where you asked for the change: ${url}`, [url]);
  }

  emailChangeNotice(to: string, cancelToken: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.cancelEmailChange, `#token=${cancelToken}`);
    return this.mail(to, "email_change_notice", true, "Your Shoestring email address is being changed",
      `Someone asked to move your Shoestring account to a new email address. If this wasn't you, use this link within 24 hours to stop or undo it: ${url}`, [url]);
  }

  emailChangeExists(to: string): OutgoingEmail {
    return this.mail(to, "email_change_exists", false, "Shoestring email change",
      "Someone asked to use this address for a Shoestring account, but an account with this address already exists. If this was you, sign in with this address instead. Otherwise you can ignore this email.", []);
  }

  emailChanged(to: string, cancelToken: string | null): OutgoingEmail {
    if (cancelToken) {
      const url = this.link(LINK_PATHS.cancelEmailChange, `#token=${cancelToken}`);
      return this.mail(to, "email_changed", true, "Your Shoestring email address was changed",
        `Your account no longer uses this address. If this wasn't you, use this link within 24 hours to undo it: ${url}`, [url]);
    }
    return this.mail(to, "email_changed", true, "Your Shoestring email address was changed",
      "Your account now uses this address and other devices were signed out.", []);
  }

  emailChangeCancelled(to: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.resetPassword);
    return this.mail(to, "email_change_cancelled", true, "A Shoestring email change was cancelled",
      `An email change on your Shoestring account was cancelled or undone, and every device was signed out. Reset your password and check your two-factor settings: ${url}`, [url]);
  }

  mfaFactorChanged(to: string, added: boolean): OutgoingEmail {
    const url = this.link(LINK_PATHS.security);
    return this.mail(to, added ? "mfa_factor_added" : "mfa_factor_removed", true,
      added ? "A two-factor method was added to your Shoestring account" : "A two-factor method was removed from your Shoestring account",
      `${added ? "A two-factor method was added." : "A two-factor method was removed."} ${SECURE_ADVICE}: ${url}`, [url]);
  }

  recoveryCodeUsed(to: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.security);
    return this.mail(to, "recovery_code_used", true, "A Shoestring recovery code was used",
      `One of your recovery codes was just used to sign in or confirm your identity. ${SECURE_ADVICE}: ${url}`, [url]);
  }

  recoveryCodesRegenerated(to: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.security);
    return this.mail(to, "recovery_codes_regenerated", true, "New Shoestring recovery codes",
      `Your recovery codes were replaced; the old ones no longer work. ${SECURE_ADVICE}: ${url}`, [url]);
  }

  recoveryCodesRetired(to: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.security);
    return this.mail(to, "recovery_codes_retired", true, "Please create new Shoestring recovery codes",
      `As a security precaution your recovery codes were retired. Your other two-factor methods still work. Create new recovery codes now: ${url}`, [url]);
  }

  mfaReset(to: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.security);
    return this.mail(to, "mfa_reset", true, "Two-factor authentication was reset on your Shoestring account",
      `At your request, the owner removed every two-factor method from your account and signed out every device. Set up two-factor authentication again now: ${url}`, [url]);
  }

  budgetRestored(to: string, budgetName: string, budgetId: string): OutgoingEmail {
    const url = this.link(`${LINK_PATHS.budgets}/${budgetId}`);
    return this.mail(to, "budget_restored", true, "A shared budget was restored",
      `The budget "${safeUserText(budgetName, 60)}" was restored by its owner and is available again: ${url}`, [url]);
  }

  accountDeletionScheduled(to: string, purgeAfter: Date): OutgoingEmail {
    const url = this.link(LINK_PATHS.signin);
    return this.mail(to, "account_deletion_scheduled", true, "Your Shoestring account will be deleted",
      `Your account will be permanently deleted after ${purgeAfter.toISOString()}. Every budget you own, including deleted budgets still waiting to be restored, is deleted with it, and they can no longer be restored after that. To keep your account, sign in and cancel the deletion before then: ${url}`, [url]);
  }

  accountDeletionCancelled(to: string): OutgoingEmail {
    const url = this.link(LINK_PATHS.security);
    return this.mail(to, "account_deletion_cancelled", true, "Your Shoestring account deletion was cancelled",
      `Your account will not be deleted. ${SECURE_ADVICE}: ${url}`, [url]);
  }
}
