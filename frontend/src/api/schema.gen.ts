// GENERATED from docs/contracts/api.openapi.yaml by frontend/scripts/gen-api.ts.
// Do not edit. Regenerate with: pnpm --filter ./frontend gen:api
/* eslint-disable */
export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Liveness. Process is up; does not touch the database. */
        get: operations["getHealthz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/readyz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Readiness. Database reachable within 1 s and migrations applied. */
        get: operations["getReadyz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Current auth state and CSRF token. The SPA calls this on boot. */
        get: operations["getAuthSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Email + password. Returns `mfa_required` if the user has MFA.
         * @description Sets a new session cookie (any existing session on this browser is revoked).
         *     If the user has MFA, the new session is `mfa_pending` (10-minute lifetime)
         *     and only the MFA endpoints accept it. Password hashing is queued behind a
         *     per-instance limit; if the queue wait exceeds 2 s the answer is 503
         *     UNAVAILABLE with Retry-After (auth.md §7). Signup, reauth and password
         *     changes share the same queue.
         */
        post: operations["login"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke the current session and clear the cookie. Always 204. */
        post: operations["logout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/mfa/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Complete sign-in with a second factor.
         * @description On success the session becomes `active`, its token is rotated (new cookie)
         *     and a new CSRF token is returned. After 5 failures the pending session is
         *     deleted and the user must sign in again.
         */
        post: operations["verifyMfa"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/webauthn/challenge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Passkey assertion options for the MFA step or for re-authentication.
         * @description `purpose: mfa` requires an `mfa_pending` session; `purpose: reauth` requires
         *     an `active` session (else 403 FORBIDDEN). One outstanding challenge per
         *     session; a new call replaces it. Challenges expire after 5 minutes.
         *     If the user has no passkeys, returns 409 MFA_NOT_ENABLED.
         */
        post: operations["createWebAuthnChallenge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/reauth": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Step-up for sensitive actions. Password, plus a second factor if enrolled.
         * @description Opens a 10-minute re-authentication window on the current session.
         *     If the user has MFA and `mfa` is omitted, returns 401 MFA_REQUIRED.
         */
        post: operations["reauthenticate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/signup/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Check a sign-up invite token and show the invited email. */
        post: operations["previewSignupInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/signup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create an account from a sign-up invite (invite-only registration).
         * @description The email comes from the invite, so holding the emailed token verifies it.
         *     Consumes the invite, creates the user and an `active` session (sets cookie).
         */
        post: operations["signup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/password-reset/request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Email a reset link if the account exists. Always 202. */
        post: operations["requestPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/password-reset/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Check a reset token and learn whether a second factor will be required. */
        post: operations["verifyPasswordResetToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/password-reset/webauthn-challenge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Passkey assertion options bound to a reset token. */
        post: operations["createPasswordResetWebAuthnChallenge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/password-reset/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set a new password. Requires a second factor when MFA is enabled.
         * @description Never bypasses MFA: if the user has any MFA factor, `mfa` is required
         *     (401 MFA_REQUIRED if missing, 401 MFA_FAILED if wrong; 5 failures
         *     invalidate the token). Success consumes the token and revokes all of
         *     the user's sessions. The user then signs in normally.
         */
        post: operations["completePasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/email-change/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirm a new email address from the link sent to it (signed in as the same user).
         * @description Requires the token **and** an `active` session of the user who requested the
         *     change (auth.md §9). A token for another user, or one whose requesting
         *     session has since been revoked, is 400 TOKEN_INVALID. Success swaps the
         *     email, deletes the user's other open one-time tokens (except
         *     `email_change_cancel`) and revokes every session except the confirming one.
         */
        post: operations["confirmEmailChange"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/email-change/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * "This wasn't me": cancel or revert an email change from the link sent to the old address.
         * @description Public; the token is the authorization. Valid for 24 hours after the change
         *     was requested. If the change is still pending it is cancelled; if it was
         *     already confirmed, the account's email reverts to the address this link
         *     was sent to (unless another account now uses it: then TOKEN_INVALID).
         *     Either way: every session is revoked; every open one-time token that is
         *     not a cancel token is deleted; and, among cancel tokens, only those
         *     created AFTER this one are deleted. Earlier cancel tokens stay valid, so
         *     an earlier cancel always wins (F-33). Both addresses (the one restored or
         *     kept and the one abandoned) are emailed. The user signs in again and
         *     should reset the password. See auth.md §9 for the regression tests.
         */
        post: operations["cancelEmailChange"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The signed-in user. */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update the display name. */
        patch: operations["updateMe"];
        trace?: never;
    };
    "/me/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Change password. Revokes all other sessions. */
        post: operations["changePassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/email-change": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send a confirmation link to a new address; notify the old one.
         * @description 202, including when the new address belongs to another account. At most
         *     one email change per 24 h: while the user has any open
         *     `email_change_cancel` token, the answer is 429 RATE_LIMITED with
         *     Retry-After until that token expires (F-33).
         */
        post: operations["requestEmailChange"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The user's active sessions (devices). */
        get: operations["listSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke one of the user's sessions. Revoking the current one signs out. */
        delete: operations["revokeSession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/sessions/revoke-others": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign out everywhere else. */
        post: operations["revokeOtherSessions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/mfa": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** MFA factors and recovery-code count. */
        get: operations["getMfa"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/mfa/totp": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start TOTP enrollment. Not active until confirmed.
         * @description Replaces any unconfirmed setup. Unconfirmed setups expire after 15 minutes.
         */
        post: operations["beginTotpSetup"];
        /** Remove TOTP. If no factor remains, MFA is off and recovery codes are deleted. */
        delete: operations["removeTotp"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/mfa/totp/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Activate TOTP with a current code.
         * @description Returns recovery codes only when this is the user's first MFA factor.
         */
        post: operations["confirmTotpSetup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/mfa/passkeys/options": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** WebAuthn creation options for registering a passkey. */
        post: operations["createPasskeyRegistrationOptions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/mfa/passkeys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register a passkey as a second factor.
         * @description Returns recovery codes only when this is the user's first MFA factor.
         */
        post: operations["registerPasskey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/mfa/passkeys/{passkeyId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                passkeyId: components["parameters"]["PasskeyId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove a passkey. If no factor remains, MFA is off and recovery codes are deleted. */
        delete: operations["removePasskey"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/mfa/recovery-codes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Replace all recovery codes with 10 new ones (shown once). */
        post: operations["regenerateRecoveryCodes"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/invitations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Pending, unexpired budget invitations addressed to my email. */
        get: operations["listMyInvitations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/invitations/{invitationId}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitationId: components["parameters"]["InvitationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Join the budget. Returns the budget.
         * @description 404 if the invitation is not addressed to my email.
         */
        post: operations["acceptInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/invitations/{invitationId}/decline": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitationId: components["parameters"]["InvitationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Decline the invitation. */
        post: operations["declineInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/deleted-budgets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Budgets I own that were deleted in the last 30 days and can still be restored (at most the 20 most recent, newest first). */
        get: operations["listDeletedBudgets"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/deleted-budgets/{deletedBudgetId}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description ID of a soft-deleted budget (not resolvable through the membership check). */
                deletedBudgetId: components["parameters"]["DeletedBudgetId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Undo a budget deletion within the 30-day grace period (owner only).
         * @description Clears the soft delete. The caller must hold the `owner` membership of the
         *     deleted budget; anyone else, an unknown ID, a budget that is not deleted,
         *     or one deleted more than 30 days ago is 404. Memberships, categories,
         *     plans and transactions come back as they were at deletion. All members
         *     are emailed. Authorized only through `requireDeletedBudgetOwnership`, which
         *     yields a `DeletedBudgetScope` (F-36, ADR-0010); the owner's account must not
         *     be pending deletion. Refused with 422 LIMIT_REACHED when the owner is
         *     already a member of 10 non-deleted budgets, or when restoring would put
         *     any other member of the budget above the hard bound of 20 non-deleted
         *     budgets (F-37). The response never says which member. Soft-deleted
         *     budgets do not count toward either limit.
         */
        post: operations["restoreDeletedBudget"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * CSV export of every budget I am a member of.
         * @description `kind: transactions` returns one row per split; `kind: plans` one row per
         *     plan entry. Columns are defined in data-model.md "CSV export". Cells that
         *     start with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`.
         */
        post: operations["exportMyData"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/deletion": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Schedule account deletion (30-day grace), revoke all sessions.
         * @description Blocked with 409 OWNS_SHARED_BUDGET while the user owns a non-deleted
         *     budget that has other members: transfer ownership, remove the members, or
         *     delete the budget first. Locks the owned budgets (data-model.md). On
         *     success every session, including this one, is revoked, every open one-time
         *     token is deleted, and the cookie is cleared.
         */
        post: operations["requestAccountDeletion"];
        /** Cancel a scheduled deletion during the grace period. */
        delete: operations["cancelAccountDeletion"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Budgets I am a member of. */
        get: operations["listBudgets"];
        put?: never;
        /**
         * Create a budget (caller becomes owner), optionally with starter categories.
         * @description Atomic. `plannedCents` on a starter category creates a plan entry for the
         *     budget's current month (in the budget timezone).
         */
        post: operations["createBudget"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        get: operations["getBudget"];
        put?: never;
        post?: never;
        /**
         * Delete the budget for every member (owner only; soft delete, purged after 30 days).
         * @description Every member is emailed a deletion notice. The owner can restore it for 30
         *     days with `POST /me/deleted-budgets/{deletedBudgetId}/restore` (ADR-0010).
         */
        delete: operations["deleteBudget"];
        options?: never;
        head?: never;
        /** Rename or change timezone (owner only). */
        patch: operations["updateBudget"];
        trace?: never;
    };
    "/budgets/{budgetId}/members": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        get: operations["listMembers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}/members/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Owner removes a member, or a member removes themself (leave).
         * @description The owner cannot remove themself (409 OWNER_CANNOT_LEAVE): transfer
         *     ownership first. The removed member is emailed a notice.
         */
        delete: operations["removeMember"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}/transfer-ownership": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Hand ownership to another member (owner only). The caller becomes a member.
         * @description Atomic role swap under a lock on the budget row (ADR-0010). The target must
         *     be a current member with an active account; a non-member target, or a member
         *     whose account is pending deletion, is 404 NOT_FOUND; the caller's own ID is
         *     400 VALIDATION_FAILED (`userId`, `invalid_value`). All
         *     members are emailed. Afterwards the former owner may leave or delete their
         *     account.
         */
        post: operations["transferOwnership"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}/invitations": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        /** Pending invitations and those answered in the last 30 days (owner only). */
        get: operations["listBudgetInvitations"];
        put?: never;
        /**
         * Invite an existing (or future) Shoestring user by email (owner only).
         * @description The response is identical whether or not an account exists for the email
         *     (no enumeration). A notification email is sent only if the account exists;
         *     otherwise the invitation waits for that email to sign up. Expires in 14 days.
         *     Requires re-auth (F-13): sharing grants access that outlives session revocation.
         *     LIMIT_REACHED: 10 pending, unexpired invitations per budget, and 20 pending,
         *     unexpired invitations per invitee email; expired ones count toward neither.
         *     Re-inviting an email whose pending invitation to this budget has expired
         *     replaces that invitation with a fresh one; an unexpired one is 409
         *     ALREADY_EXISTS (`invitation_pending`).
         */
        post: operations["createBudgetInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}/invitations/{invitationId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                invitationId: components["parameters"]["InvitationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke a pending invitation (owner only). */
        delete: operations["revokeBudgetInvitation"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}/categories": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        get: operations["listCategories"];
        put?: never;
        post: operations["createCategory"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}/categories/{categoryId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                categoryId: components["parameters"]["CategoryId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Hard-delete an unused category. Use archive if any transaction uses it.
         * @description 409 CATEGORY_IN_USE if any split (including on a soft-deleted transaction
         *     not yet purged) references it. Its plan entries are deleted with it.
         */
        delete: operations["deleteCategory"];
        options?: never;
        head?: never;
        /** Rename, reorder, archive or unarchive. `kind` is immutable. */
        patch: operations["updateCategory"];
        trace?: never;
    };
    "/budgets/{budgetId}/months/{month}/plan": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                month: components["parameters"]["Month"];
            };
            cookie?: never;
        };
        /** Plan entries (monthly limits) for a month. Missing entry means 0. */
        get: operations["getMonthPlan"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}/months/{month}/plan/{categoryId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                month: components["parameters"]["Month"];
                categoryId: components["parameters"]["CategoryId"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Set a category's planned amount for the month (create or replace).
         * @description `version: null` means "I expect no entry yet" (create, 201). Otherwise the
         *     entry's current version (replace, 200). Mismatch is 409 VERSION_CONFLICT.
         */
        put: operations["putPlanEntry"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}/months/{month}/plan/copy-previous": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                month: components["parameters"]["Month"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Copy the previous month's plan into this month (J5).
         * @description Copies entries from month-1 for non-archived categories. With
         *     `overwrite: false` (default) only categories with no entry this month are
         *     filled; with `overwrite: true` existing entries are replaced (no version
         *     check; this is an explicit bulk action). Atomic. An empty previous month
         *     returns 200 with `copiedCount: 0`.
         */
        post: operations["copyPreviousMonthPlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}/months/{month}/summary": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                month: components["parameters"]["Month"];
            };
            cookie?: never;
        };
        /**
         * Planned, actual and remaining per category, with totals (J3).
         * @description Formulas are in ADR-0004. All arithmetic is done on the server.
         */
        get: operations["getMonthSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}/transactions": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        /**
         * Transactions, newest first, cursor-paginated (J4).
         * @description Order is `date DESC, id DESC` (id is UUIDv7, so ties break by creation
         *     time). Cursors carry a MAC over budget ID, filters and position; a cursor
         *     used with another budget or other filters, or tampered with, is 400
         *     VALIDATION_FAILED (`query.cursor`, `invalid_value`). A `categoryId` filter
         *     that is not a category of this budget returns an empty page.
         */
        get: operations["listTransactions"];
        put?: never;
        /**
         * Record a transaction with 1..20 splits (J2).
         * @description Requires `Idempotency-Key`. A retry with the same key and body returns
         *     201 with the transaction's current state and `Idempotent-Replayed: true`,
         *     loaded through the current BudgetScope (a since-deleted transaction
         *     replays as 404); the same key with a different body is 422
         *     IDEMPOTENCY_KEY_REUSED. A split `categoryId` that is not a category of
         *     this budget is 400 VALIDATION_FAILED (`splits.N.categoryId`,
         *     `invalid_value`), checked before any write.
         */
        post: operations["createTransaction"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/budgets/{budgetId}/transactions/{transactionId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                transactionId: components["parameters"]["TransactionId"];
            };
            cookie?: never;
        };
        get: operations["getTransaction"];
        /**
         * Replace all editable fields, including the full splits array.
         * @description Optimistic concurrency: `version` must equal the current version, else
         *     409 VERSION_CONFLICT (the client refetches and shows both). An archived
         *     category may stay on a split only if it was already on this transaction.
         *     A split `categoryId` outside this budget is 400 VALIDATION_FAILED
         *     (`splits.N.categoryId`, `invalid_value`).
         */
        put: operations["replaceTransaction"];
        post?: never;
        /** Soft-delete (purged after 30 days). Hidden from lists and summaries at once. */
        delete: operations["deleteTransaction"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** Format: uuid */
        Uuid: string;
        RequestId: string;
        /**
         * Format: date-time
         * @description RFC 3339 UTC with `Z`, millisecond precision.
         */
        Timestamp: string;
        /**
         * Format: date
         * @description Calendar date `YYYY-MM-DD` (no time, no zone).
         */
        Date: string;
        /** @description Calendar month `YYYY-MM`. */
        Month: string;
        /** @description Non-negative USD cents. Max $1,000,000.00. */
        Cents: number;
        /** @description Positive USD cents. Max $1,000,000.00. */
        PositiveCents: number;
        /** @description USD cents; may be negative (e.g. overspent remaining). */
        SignedCents: number;
        /** @description Row version; starts at 1 and increments on every update. */
        Version: number;
        /** @description Opaque base64url cursor. */
        Cursor: string;
        /** Format: email */
        Email: string;
        /** @description Opaque base64url token from an emailed link (taken from the URL fragment). */
        Token: string;
        /** @description Policy in auth.md (length, breached-password check). Violations are VALIDATION_FAILED with issue codes. */
        NewPassword: string;
        DisplayName: string;
        /**
         * @description IANA zone name accepted by the server's Intl database, e.g. `America/Chicago`.
         * @example America/New_York
         */
        Timezone: string;
        /** @enum {string} */
        Role: "owner" | "member";
        /** @enum {string} */
        CategoryKind: "expense" | "income";
        /**
         * @description outflow = money spent; inflow = money received (income or refund).
         * @enum {string}
         */
        Direction: "outflow" | "inflow";
        /** @enum {string} */
        MfaMethod: "totp" | "passkey" | "recovery_code";
        /**
         * @description Stable machine-readable code. Registry and HTTP status in errors.md.
         * @enum {string}
         */
        ErrorCode: "VALIDATION_FAILED" | "INVITATION_INVALID" | "TOKEN_INVALID" | "UNAUTHENTICATED" | "INVALID_CREDENTIALS" | "MFA_REQUIRED" | "MFA_FAILED" | "CSRF_FAILED" | "FORBIDDEN" | "REAUTH_REQUIRED" | "ACCOUNT_PENDING_DELETION" | "NOT_FOUND" | "VERSION_CONFLICT" | "ALREADY_EXISTS" | "CATEGORY_IN_USE" | "OWNER_CANNOT_LEAVE" | "OWNS_SHARED_BUDGET" | "MFA_NOT_ENABLED" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "SPLITS_DO_NOT_SUM" | "CATEGORY_ARCHIVED" | "IDEMPOTENCY_KEY_REUSED" | "LIMIT_REACHED" | "RATE_LIMITED" | "INTERNAL" | "UNAVAILABLE";
        /**
         * @description Stable per-field issue code. Registry in errors.md.
         * @enum {string}
         */
        FieldIssue: "required" | "unknown_field" | "invalid_type" | "invalid_format" | "invalid_value" | "too_small" | "too_big" | "too_short" | "too_long" | "breached_password" | "duplicate" | "sum_mismatch" | "archived" | "already_member" | "invitation_pending" | "limit";
        FieldError: {
            /** @enum {string} */
            in: "body" | "query" | "path" | "header";
            /** @description Dotted path within `in`, array indexes as numbers (`splits.1.amountCents`). Empty string = the whole location. */
            field: string;
            issue: components["schemas"]["FieldIssue"];
            /** @description Safe English fallback. Never echoes the submitted value. */
            message: string;
        };
        ErrorBody: {
            code: components["schemas"]["ErrorCode"];
            /** @description Safe, human-readable fallback. Clients map `code` to their own copy. */
            message: string;
            requestId: components["schemas"]["RequestId"];
            /** @description Present for VALIDATION_FAILED (always, at least one item) and optionally for 409/422 domain codes. */
            details?: components["schemas"]["FieldError"][];
        };
        Health: {
            /** @enum {string} */
            status: "ok";
            /** @description Build git SHA (public repo, so not secret) */
            version: string;
        };
        Readiness: {
            /** @enum {string} */
            status: "ok";
            checks: {
                /** @enum {string} */
                database: "ok";
            };
        };
        LoginRequest: {
            email: components["schemas"]["Email"];
            password: string;
        };
        TokenRequest: {
            token: components["schemas"]["Token"];
        };
        EmailRequest: {
            email: components["schemas"]["Email"];
        };
        SignupPreview: {
            email: components["schemas"]["Email"];
            expiresAt: components["schemas"]["Timestamp"];
        };
        SignupRequest: {
            token: components["schemas"]["Token"];
            displayName: components["schemas"]["DisplayName"];
            password: components["schemas"]["NewPassword"];
        };
        TotpProof: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            method: "totp";
            code: string;
        };
        PasskeyProof: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            method: "passkey";
            assertion: components["schemas"]["WebAuthnAssertion"];
        };
        RecoveryCodeProof: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            method: "recovery_code";
            /** @description Case-insensitive; the hyphen is optional. */
            code: string;
        };
        MfaProof: components["schemas"]["TotpProof"] | components["schemas"]["PasskeyProof"] | components["schemas"]["RecoveryCodeProof"];
        /** @description AuthenticationResponseJSON (WebAuthn L3), as produced by the browser library. Verified server-side. */
        WebAuthnAssertion: {
            id: string;
            rawId: string;
            /** @constant */
            type: "public-key";
            response: Record<string, never>;
            clientExtensionResults?: Record<string, never>;
            authenticatorAttachment?: string | null;
        };
        /** @description RegistrationResponseJSON (WebAuthn L3). Verified server-side. */
        WebAuthnRegistrationResponse: {
            id: string;
            rawId: string;
            /** @constant */
            type: "public-key";
            response: Record<string, never>;
            clientExtensionResults?: Record<string, never>;
            authenticatorAttachment?: string | null;
        };
        /** @description PublicKeyCredentialRequestOptionsJSON (WebAuthn L3). */
        WebAuthnRequestOptions: {
            challenge: string;
            rpId: string;
            allowCredentials: Record<string, never>[];
            /** @enum {string} */
            userVerification: "preferred";
            timeout: number;
        };
        /** @description PublicKeyCredentialCreationOptionsJSON (WebAuthn L3). attestation is `none`. */
        WebAuthnCreationOptions: {
            challenge: string;
            rp: Record<string, never>;
            user: Record<string, never>;
            pubKeyCredParams: Record<string, never>[];
            excludeCredentials: Record<string, never>[];
            authenticatorSelection: Record<string, never>;
            /** @enum {string} */
            attestation: "none";
            timeout: number;
        };
        WebAuthnChallengeRequest: {
            /** @enum {string} */
            purpose: "mfa" | "reauth";
        };
        ReauthRequest: {
            password: string;
            mfa?: components["schemas"]["MfaProof"];
        };
        ReauthResult: {
            reauthenticatedUntil: components["schemas"]["Timestamp"];
        };
        PasswordResetStatus: {
            mfaRequired: boolean;
            /** @description Empty when mfaRequired is false. */
            mfaMethods: components["schemas"]["MfaMethod"][];
        };
        PasswordResetComplete: {
            token: components["schemas"]["Token"];
            newPassword: components["schemas"]["NewPassword"];
            mfa?: components["schemas"]["MfaProof"];
        };
        CurrentSession: {
            id: components["schemas"]["Uuid"];
            expiresAt: components["schemas"]["Timestamp"];
            /**
             * Format: date-time
             * @description End of the re-authentication window; null if none is open.
             */
            reauthenticatedUntil: string | null;
        };
        AuthenticatedState: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            state: "authenticated";
            user: components["schemas"]["Me"];
            session: components["schemas"]["CurrentSession"];
            csrfToken: string;
        };
        MfaRequiredState: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            state: "mfa_required";
            mfaMethods: components["schemas"]["MfaMethod"][];
            expiresAt: components["schemas"]["Timestamp"];
            csrfToken: string;
        };
        AuthState: components["schemas"]["AuthenticatedState"] | components["schemas"]["MfaRequiredState"];
        MfaSummary: {
            /** @description True iff at least one factor (TOTP or passkey) is active */
            enabled: boolean;
            totp: boolean;
            passkeyCount: number;
            recoveryCodesRemaining: number;
        };
        DeletionStatus: {
            requestedAt: components["schemas"]["Timestamp"];
            purgeAfter: components["schemas"]["Timestamp"];
        };
        Me: {
            id: components["schemas"]["Uuid"];
            email: components["schemas"]["Email"];
            displayName: components["schemas"]["DisplayName"];
            createdAt: components["schemas"]["Timestamp"];
            mfa: components["schemas"]["MfaSummary"];
            /** @description Non-null while the account is pending deletion (restricted mode). */
            deletion: components["schemas"]["DeletionStatus"] | null;
        };
        MeUpdate: {
            displayName: components["schemas"]["DisplayName"];
        };
        PasswordChange: {
            newPassword: components["schemas"]["NewPassword"];
        };
        EmailChangeRequest: {
            newEmail: components["schemas"]["Email"];
        };
        SessionInfo: {
            id: components["schemas"]["Uuid"];
            current: boolean;
            browser: components["schemas"]["DeviceBrowser"];
            os: components["schemas"]["DeviceOs"];
            createdAt: components["schemas"]["Timestamp"];
            lastSeenAt: components["schemas"]["Timestamp"];
            /** @description The earlier of the 30-day sliding expiry and the 90-day absolute cap. */
            expiresAt: components["schemas"]["Timestamp"];
        };
        /**
         * @description Fixed vocabulary derived from the User-Agent at sign-in; no raw UA text (F-20).
         * @enum {string}
         */
        DeviceBrowser: "safari" | "chrome" | "firefox" | "edge" | "samsung_internet" | "other" | "unknown";
        /** @enum {string} */
        DeviceOs: "ios" | "ipados" | "android" | "macos" | "windows" | "linux" | "chromeos" | "other" | "unknown";
        SessionList: {
            items: components["schemas"]["SessionInfo"][];
        };
        Passkey: {
            id: components["schemas"]["Uuid"];
            name: string;
            createdAt: components["schemas"]["Timestamp"];
            /** Format: date-time */
            lastUsedAt: string | null;
        };
        MfaDetail: {
            enabled: boolean;
            totp: {
                enabled: boolean;
                /** Format: date-time */
                confirmedAt: string | null;
            };
            passkeys: components["schemas"]["Passkey"][];
            recoveryCodesRemaining: number;
        };
        TotpSetup: {
            /** @description Base32 secret (160 bits) for manual entry */
            secret: string;
            /** @description otpauth://totp/Shoestring:<email>?secret=...&issuer=Shoestring&algorithm=SHA1&digits=6&period=30 (render as a QR code client-side) */
            otpauthUri: string;
            expiresAt: components["schemas"]["Timestamp"];
        };
        TotpConfirm: {
            code: string;
        };
        RecoveryCodes: {
            recoveryCodes: string[];
        };
        MfaEnrollResult: {
            /** @description Ten codes when this was the first factor; otherwise null. */
            recoveryCodes: string[] | null;
        };
        PasskeyRegistration: {
            name: string;
            credential: components["schemas"]["WebAuthnRegistrationResponse"];
        };
        PasskeyEnrollResult: {
            passkey: components["schemas"]["Passkey"];
            /** @description Ten codes when this was the first factor; otherwise null. */
            recoveryCodes: string[] | null;
        };
        StarterCategory: {
            name: string;
            kind: components["schemas"]["CategoryKind"];
            plannedCents?: components["schemas"]["Cents"];
        };
        BudgetCreate: {
            name: string;
            timezone: components["schemas"]["Timezone"];
            categories?: components["schemas"]["StarterCategory"][];
        };
        BudgetUpdate: {
            name?: string;
            timezone?: components["schemas"]["Timezone"];
            version: components["schemas"]["Version"];
        };
        Budget: {
            id: components["schemas"]["Uuid"];
            name: string;
            timezone: components["schemas"]["Timezone"];
            /** @constant */
            currency: "USD";
            myRole: components["schemas"]["Role"];
            memberCount: number;
            /** @description Today's date in the budget timezone, at response time. */
            today: components["schemas"]["Date"];
            /** @description Current month in the budget timezone, at response time. */
            currentMonth: components["schemas"]["Month"];
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
            version: components["schemas"]["Version"];
        };
        BudgetList: {
            /**
             * @description Hard bound 20 (F-37). Create and accept stop at 10 non-deleted budgets;
             *     only an owner's restore can take a co-member past 10, and never past 20.
             */
            items: components["schemas"]["Budget"][];
        };
        Member: {
            userId: components["schemas"]["Uuid"];
            displayName: components["schemas"]["DisplayName"];
            role: components["schemas"]["Role"];
            joinedAt: components["schemas"]["Timestamp"];
        };
        MemberList: {
            items: components["schemas"]["Member"][];
        };
        InvitationCreate: {
            email: components["schemas"]["Email"];
        };
        Invitation: {
            id: components["schemas"]["Uuid"];
            budgetId: components["schemas"]["Uuid"];
            email: components["schemas"]["Email"];
            /**
             * @description `expired` is derived: stored status pending and expiresAt in the past.
             * @enum {string}
             */
            status: "pending" | "accepted" | "declined" | "revoked" | "expired";
            invitedByDisplayName: string | null;
            createdAt: components["schemas"]["Timestamp"];
            expiresAt: components["schemas"]["Timestamp"];
            /** Format: date-time */
            respondedAt: string | null;
        };
        InvitationList: {
            items: components["schemas"]["Invitation"][];
        };
        MyInvitation: {
            id: components["schemas"]["Uuid"];
            budgetId: components["schemas"]["Uuid"];
            budgetName: string;
            invitedByDisplayName: string | null;
            expiresAt: components["schemas"]["Timestamp"];
        };
        MyInvitationList: {
            /** @description Newest first. At most 20 pending, unexpired invitations can exist per invitee email. */
            items: components["schemas"]["MyInvitation"][];
        };
        Category: {
            id: components["schemas"]["Uuid"];
            budgetId: components["schemas"]["Uuid"];
            name: string;
            kind: components["schemas"]["CategoryKind"];
            sortOrder: number;
            archived: boolean;
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
            version: components["schemas"]["Version"];
        };
        CategoryList: {
            items: components["schemas"]["Category"][];
        };
        CategoryCreate: {
            name: string;
            kind: components["schemas"]["CategoryKind"];
            /** @description Default: after the last category */
            sortOrder?: number;
        };
        CategoryUpdate: {
            name?: string;
            sortOrder?: number;
            archived?: boolean;
            version: components["schemas"]["Version"];
        };
        PlanEntry: {
            categoryId: components["schemas"]["Uuid"];
            month: components["schemas"]["Month"];
            amountCents: components["schemas"]["Cents"];
            updatedAt: components["schemas"]["Timestamp"];
            /** Format: uuid */
            updatedByUserId: string | null;
            version: components["schemas"]["Version"];
        };
        MonthPlan: {
            budgetId: components["schemas"]["Uuid"];
            month: components["schemas"]["Month"];
            items: components["schemas"]["PlanEntry"][];
        };
        PlanEntryPut: {
            amountCents: components["schemas"]["Cents"];
            /** @description Current version, or null to create. */
            version: components["schemas"]["Version"] | null;
        };
        PlanCopyRequest: {
            /** @default false */
            overwrite: boolean;
        };
        PlanCopyResult: {
            budgetId: components["schemas"]["Uuid"];
            month: components["schemas"]["Month"];
            sourceMonth: components["schemas"]["Month"];
            copiedCount: number;
            /** @description Source entries not copied (archived category, or target already set and overwrite=false). */
            skippedCount: number;
            items: components["schemas"]["PlanEntry"][];
        };
        CategorySummary: {
            categoryId: components["schemas"]["Uuid"];
            name: string;
            kind: components["schemas"]["CategoryKind"];
            archived: boolean;
            plannedCents: components["schemas"]["Cents"];
            /** @description expense = outflows - inflows (spent); income = inflows - outflows (received). */
            actualCents: components["schemas"]["SignedCents"];
            /** @description plannedCents - actualCents. Negative for an expense category means overspent. */
            remainingCents: components["schemas"]["SignedCents"];
        };
        SummaryTotals: {
            plannedCents: number;
            actualCents: components["schemas"]["SignedCents"];
            remainingCents: components["schemas"]["SignedCents"];
        };
        MonthSummary: {
            budgetId: components["schemas"]["Uuid"];
            month: components["schemas"]["Month"];
            /** @description All non-archived categories, plus archived ones with a plan entry or activity this month. Ordered by kind (expense first), sortOrder, name. */
            categories: components["schemas"]["CategorySummary"][];
            totals: {
                expense: components["schemas"]["SummaryTotals"];
                income: components["schemas"]["SummaryTotals"];
            };
            transactionCount: number;
        };
        SplitWrite: {
            categoryId: components["schemas"]["Uuid"];
            amountCents: components["schemas"]["PositiveCents"];
        };
        TransactionSplit: {
            categoryId: components["schemas"]["Uuid"];
            amountCents: components["schemas"]["PositiveCents"];
        };
        /** @description Sensitive. Trimmed; empty becomes null. Never logged. */
        Payee: string | null;
        /** @description Sensitive. Trimmed; empty becomes null. Never logged. */
        Memo: string | null;
        TransactionCreate: {
            /** @description From 2000-01-01 to one year after today (budget timezone). */
            date: components["schemas"]["Date"];
            direction: components["schemas"]["Direction"];
            amountCents: components["schemas"]["PositiveCents"];
            payee?: components["schemas"]["Payee"];
            memo?: components["schemas"]["Memo"];
            /** @description One split = an ordinary transaction. Categories must be distinct; amounts must sum to amountCents. */
            splits: components["schemas"]["SplitWrite"][];
        };
        TransactionReplace: {
            date: components["schemas"]["Date"];
            direction: components["schemas"]["Direction"];
            amountCents: components["schemas"]["PositiveCents"];
            payee: components["schemas"]["Payee"];
            memo: components["schemas"]["Memo"];
            splits: components["schemas"]["SplitWrite"][];
            version: components["schemas"]["Version"];
        };
        Transaction: {
            id: components["schemas"]["Uuid"];
            budgetId: components["schemas"]["Uuid"];
            date: components["schemas"]["Date"];
            direction: components["schemas"]["Direction"];
            amountCents: components["schemas"]["PositiveCents"];
            payee: string | null;
            memo: string | null;
            /** @description Ordered by amount descending, then categoryId. */
            splits: components["schemas"]["TransactionSplit"][];
            /**
             * Format: uuid
             * @description Null after the creator's account is purged.
             */
            createdByUserId: string | null;
            /** Format: uuid */
            updatedByUserId: string | null;
            createdAt: components["schemas"]["Timestamp"];
            updatedAt: components["schemas"]["Timestamp"];
            version: components["schemas"]["Version"];
        };
        TransactionPage: {
            items: components["schemas"]["Transaction"][];
            /** @description Null on the last page. */
            nextCursor: components["schemas"]["Cursor"] | null;
        };
        OwnershipTransfer: {
            userId: components["schemas"]["Uuid"];
        };
        DeletedBudget: {
            id: components["schemas"]["Uuid"];
            name: string;
            deletedAt: components["schemas"]["Timestamp"];
            /** @description deletedAt + 30 days. */
            restorableUntil: components["schemas"]["Timestamp"];
            memberCount: number;
        };
        DeletedBudgetList: {
            /** @description The 20 most recently deleted budgets still inside their restore window, newest first. Older ones are not listed but stay restorable by ID until their window ends. */
            items: components["schemas"]["DeletedBudget"][];
        };
        ExportRequest: {
            /** @enum {string} */
            kind: "transactions" | "plans";
        };
    };
    responses: {
        /** @description Any other error (413, 415, 500, 503). See errors.md. */
        Error: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorBody"];
            };
        };
        /** @description VALIDATION_FAILED, INVITATION_INVALID or TOKEN_INVALID */
        BadRequest: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorBody"];
            };
        };
        /** @description UNAUTHENTICATED, INVALID_CREDENTIALS, MFA_REQUIRED or MFA_FAILED */
        Unauthorized: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorBody"];
            };
        };
        /** @description CSRF_FAILED, FORBIDDEN, REAUTH_REQUIRED or ACCOUNT_PENDING_DELETION */
        Forbidden: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorBody"];
            };
        };
        /** @description NOT_FOUND (missing, deleted, or not visible to the caller) */
        NotFound: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorBody"];
            };
        };
        /** @description VERSION_CONFLICT, ALREADY_EXISTS, CATEGORY_IN_USE, OWNER_CANNOT_LEAVE, OWNS_SHARED_BUDGET or MFA_NOT_ENABLED */
        Conflict: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorBody"];
            };
        };
        /** @description SPLITS_DO_NOT_SUM, CATEGORY_ARCHIVED, IDEMPOTENCY_KEY_REUSED or LIMIT_REACHED */
        Unprocessable: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorBody"];
            };
        };
        /** @description RATE_LIMITED */
        TooManyRequests: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                "Retry-After": components["headers"]["RetryAfter"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorBody"];
            };
        };
        /** @description UNAVAILABLE (Retry-After set when the server can estimate it, e.g. the password-hashing queue) */
        ServiceUnavailable: {
            headers: {
                "X-Request-Id": components["headers"]["RequestId"];
                "Retry-After": components["headers"]["RetryAfter"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorBody"];
            };
        };
    };
    parameters: {
        /** @description ID of a soft-deleted budget (not resolvable through the membership check). */
        DeletedBudgetId: components["schemas"]["Uuid"];
        BudgetId: components["schemas"]["Uuid"];
        CategoryId: components["schemas"]["Uuid"];
        TransactionId: components["schemas"]["Uuid"];
        InvitationId: components["schemas"]["Uuid"];
        UserId: components["schemas"]["Uuid"];
        SessionId: components["schemas"]["Uuid"];
        PasskeyId: components["schemas"]["Uuid"];
        Month: components["schemas"]["Month"];
        /** @description The version the client last saw (optimistic concurrency). */
        VersionQuery: components["schemas"]["Version"];
        /** @description Client-generated UUID, new per user intent, reused on retries. Kept 24 h. */
        IdempotencyKey: components["schemas"]["Uuid"];
    };
    requestBodies: never;
    headers: {
        /** @description Request correlation ID (echoed or generated). See errors.md. */
        RequestId: components["schemas"]["RequestId"];
        /** @description `__Host-ss_sid=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000` (Max-Age=600 for an mfa_pending session) */
        SetSessionCookie: string;
        /** @description `__Host-ss_sid=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` */
        ClearSessionCookie: string;
        /** @description `true` when this response replays an earlier request with the same Idempotency-Key. */
        IdempotentReplayed: "true";
        /** @description Seconds until the client may retry. */
        RetryAfter: number;
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealthz: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Process is alive */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Health"];
                };
            };
            default: components["responses"]["Error"];
        };
    };
    getReadyz: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ready to serve traffic */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Readiness"];
                };
            };
            503: components["responses"]["ServiceUnavailable"];
            default: components["responses"]["Error"];
        };
    };
    getAuthSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Signed in, or awaiting MFA */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthState"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Error"];
        };
    };
    login: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Authenticated, or MFA step required */
            200: {
                headers: {
                    "Set-Cookie": components["headers"]["SetSessionCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthState"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    logout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Signed out (also when there was no session) */
            204: {
                headers: {
                    "Set-Cookie": components["headers"]["ClearSessionCookie"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Error"];
        };
    };
    verifyMfa: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MfaProof"];
            };
        };
        responses: {
            /** @description Signed in */
            200: {
                headers: {
                    "Set-Cookie": components["headers"]["SetSessionCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthState"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    createWebAuthnChallenge: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebAuthnChallengeRequest"];
            };
        };
        responses: {
            /** @description PublicKeyCredentialRequestOptionsJSON */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebAuthnRequestOptions"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    reauthenticate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReauthRequest"];
            };
        };
        responses: {
            /** @description Re-authenticated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReauthResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    previewSignupInvite: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TokenRequest"];
            };
        };
        responses: {
            /** @description Invite is valid */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignupPreview"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    signup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SignupRequest"];
            };
        };
        responses: {
            /** @description Account created and signed in */
            201: {
                headers: {
                    "Set-Cookie": components["headers"]["SetSessionCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthState"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    requestPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EmailRequest"];
            };
        };
        responses: {
            /** @description Accepted (identical whether or not the account exists) */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    verifyPasswordResetToken: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TokenRequest"];
            };
        };
        responses: {
            /** @description Token is valid */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PasswordResetStatus"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    createPasswordResetWebAuthnChallenge: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TokenRequest"];
            };
        };
        responses: {
            /** @description PublicKeyCredentialRequestOptionsJSON */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebAuthnRequestOptions"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    completePasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordResetComplete"];
            };
        };
        responses: {
            /** @description Password changed; all sessions revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    confirmEmailChange: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TokenRequest"];
            };
        };
        responses: {
            /** @description Email changed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    cancelEmailChange: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TokenRequest"];
            };
        };
        responses: {
            /** @description Change cancelled or reverted; all sessions revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current user */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            401: components["responses"]["Unauthorized"];
            default: components["responses"]["Error"];
        };
    };
    updateMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MeUpdate"];
            };
        };
        responses: {
            /** @description Updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Error"];
        };
    };
    changePassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordChange"];
            };
        };
        responses: {
            /** @description Changed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Error"];
        };
    };
    requestEmailChange: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EmailChangeRequest"];
            };
        };
        responses: {
            /** @description Accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    listSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Sessions, most recently seen first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionList"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Error"];
        };
    };
    revokeSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    revokeOtherSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description All other sessions revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Error"];
        };
    };
    getMfa: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description MFA detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MfaDetail"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Error"];
        };
    };
    beginTotpSetup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Secret to add to an authenticator app */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TotpSetup"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["Error"];
        };
    };
    removeTotp: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    confirmTotpSetup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TotpConfirm"];
            };
        };
        responses: {
            /** @description TOTP active */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MfaEnrollResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    createPasskeyRegistrationOptions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description PublicKeyCredentialCreationOptionsJSON */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebAuthnCreationOptions"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["Unprocessable"];
            default: components["responses"]["Error"];
        };
    };
    registerPasskey: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasskeyRegistration"];
            };
        };
        responses: {
            /** @description Passkey registered */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PasskeyEnrollResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Unprocessable"];
            default: components["responses"]["Error"];
        };
    };
    removePasskey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                passkeyId: components["parameters"]["PasskeyId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    regenerateRecoveryCodes: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description New codes; old codes no longer work */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecoveryCodes"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["Error"];
        };
    };
    listMyInvitations: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Invitations */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MyInvitationList"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Error"];
        };
    };
    acceptInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitationId: components["parameters"]["InvitationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Joined */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Budget"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Unprocessable"];
            default: components["responses"]["Error"];
        };
    };
    declineInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitationId: components["parameters"]["InvitationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Declined */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    listDeletedBudgets: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted budgets, most recently deleted first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletedBudgetList"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Error"];
        };
    };
    restoreDeletedBudget: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description ID of a soft-deleted budget (not resolvable through the membership check). */
                deletedBudgetId: components["parameters"]["DeletedBudgetId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Restored */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Budget"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["Unprocessable"];
            default: components["responses"]["Error"];
        };
    };
    exportMyData: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExportRequest"];
            };
        };
        responses: {
            /** @description CSV file (RFC 4180, UTF-8, header row) */
            200: {
                headers: {
                    /** @description `attachment; filename="shoestring-<kind>-<YYYY-MM-DD>.csv"` */
                    "Content-Disposition"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/csv": string;
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    requestAccountDeletion: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deletion scheduled */
            202: {
                headers: {
                    "Set-Cookie": components["headers"]["ClearSessionCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeletionStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["Error"];
        };
    };
    cancelAccountDeletion: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deletion cancelled; account active again */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    listBudgets: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Budgets, by name */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BudgetList"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            default: components["responses"]["Error"];
        };
    };
    createBudget: {
        parameters: {
            query?: never;
            header: {
                /** @description Client-generated UUID, new per user intent, reused on retries. Kept 24 h. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BudgetCreate"];
            };
        };
        responses: {
            /** @description Created (or replayed for the same Idempotency-Key) */
            201: {
                headers: {
                    "Idempotent-Replayed": components["headers"]["IdempotentReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Budget"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["Unprocessable"];
            default: components["responses"]["Error"];
        };
    };
    getBudget: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Budget */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Budget"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    deleteBudget: {
        parameters: {
            query: {
                /** @description The version the client last saw (optimistic concurrency). */
                version: components["parameters"]["VersionQuery"];
            };
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["Error"];
        };
    };
    updateBudget: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BudgetUpdate"];
            };
        };
        responses: {
            /** @description Updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Budget"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["Error"];
        };
    };
    listMembers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Members, owner first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberList"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    removeMember: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["Error"];
        };
    };
    transferOwnership: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OwnershipTransfer"];
            };
        };
        responses: {
            /** @description Ownership transferred; the budget as the caller now sees it (myRole member) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Budget"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    listBudgetInvitations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Invitations, newest first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InvitationList"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    createBudgetInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InvitationCreate"];
            };
        };
        responses: {
            /** @description Invitation created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Invitation"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Unprocessable"];
            429: components["responses"]["TooManyRequests"];
            default: components["responses"]["Error"];
        };
    };
    revokeBudgetInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                invitationId: components["parameters"]["InvitationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    listCategories: {
        parameters: {
            query?: {
                includeArchived?: boolean;
            };
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Categories by sortOrder, then name */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CategoryList"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    createCategory: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CategoryCreate"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Category"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Unprocessable"];
            default: components["responses"]["Error"];
        };
    };
    deleteCategory: {
        parameters: {
            query: {
                /** @description The version the client last saw (optimistic concurrency). */
                version: components["parameters"]["VersionQuery"];
            };
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                categoryId: components["parameters"]["CategoryId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["Error"];
        };
    };
    updateCategory: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                categoryId: components["parameters"]["CategoryId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CategoryUpdate"];
            };
        };
        responses: {
            /** @description Updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Category"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["Error"];
        };
    };
    getMonthPlan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                month: components["parameters"]["Month"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Plan */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MonthPlan"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    putPlanEntry: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                month: components["parameters"]["Month"];
                categoryId: components["parameters"]["CategoryId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlanEntryPut"];
            };
        };
        responses: {
            /** @description Replaced */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanEntry"];
                };
            };
            /** @description Created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanEntry"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Unprocessable"];
            default: components["responses"]["Error"];
        };
    };
    copyPreviousMonthPlan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                month: components["parameters"]["Month"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlanCopyRequest"];
            };
        };
        responses: {
            /** @description Resulting plan for the month */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanCopyResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    getMonthSummary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                month: components["parameters"]["Month"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Summary */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MonthSummary"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    listTransactions: {
        parameters: {
            query?: {
                month?: components["schemas"]["Month"];
                /** @description Transactions with at least one split in this category. */
                categoryId?: components["schemas"]["Uuid"];
                limit?: number;
                cursor?: components["schemas"]["Cursor"];
            };
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of transactions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TransactionPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    createTransaction: {
        parameters: {
            query?: never;
            header: {
                /** @description Client-generated UUID, new per user intent, reused on retries. Kept 24 h. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                budgetId: components["parameters"]["BudgetId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TransactionCreate"];
            };
        };
        responses: {
            /** @description Created (or replayed) */
            201: {
                headers: {
                    "Idempotent-Replayed": components["headers"]["IdempotentReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Transaction"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["Unprocessable"];
            default: components["responses"]["Error"];
        };
    };
    getTransaction: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                transactionId: components["parameters"]["TransactionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Transaction */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Transaction"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            default: components["responses"]["Error"];
        };
    };
    replaceTransaction: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                transactionId: components["parameters"]["TransactionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TransactionReplace"];
            };
        };
        responses: {
            /** @description Updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Transaction"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["Unprocessable"];
            default: components["responses"]["Error"];
        };
    };
    deleteTransaction: {
        parameters: {
            query: {
                /** @description The version the client last saw (optimistic concurrency). */
                version: components["parameters"]["VersionQuery"];
            };
            header?: never;
            path: {
                budgetId: components["parameters"]["BudgetId"];
                transactionId: components["parameters"]["TransactionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            default: components["responses"]["Error"];
        };
    };
}
