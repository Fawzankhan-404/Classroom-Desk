# Legacy account recovery

## Scope and authority

This flow is for an existing account whose encrypted profile cannot be opened.
It does not create a replacement account, change billing, transfer an
entitlement, or expose the legacy ciphertext. It requires migration `0014`
after `0013`; neither migration has been applied to production by this work.

The recovery review page is `/admin/account-recovery`. It accepts only an
existing website session whose user record has the active `SUPER_ADMIN` role.
The role is read from the stored account row after session validation. Email,
display name, and username are not used to grant administrator access. The
owner reviews the queue and remains responsible for verifying evidence.

## Recovery steps

1. The claimant opens `/account/recovery` and completes a fresh Google OIDC
   sign-in. The callback verifies Google's signed ID token, audience, issuer,
   expiry, nonce, verified email, and stable subject, and uses PKCE. The flow
   creates only a short-lived recovery session; it does not upsert an account
   or grant Classroom/MCP access.
2. The claimant submits the exact legacy account UUID and a reference to an
   existing independent ownership record. Email equality, a new Google login,
   knowledge of the UUID, and a claimant-supplied name are insufficient by
   themselves. The request does not confirm whether an account exists.
3. The owner inspects the evidence reference and verifies from an authoritative
   record created before the request that this claimant owns that exact legacy
   account and that the newly verified Google identity is the one to bind. A
   matching email or Google sign-in alone is not independent evidence. If the
   record is absent, ambiguous, or identifies another account, reject the
   request. Do not approve by guessing.
4. Approval records the owner account ID, evidence category, and a keyed hash
   of the evidence reference. The reference itself is encrypted at rest. The
   approval creates a request bound to the stable Google subject and a hash of
   the unchanged legacy ciphertext. It expires after 24 hours and can be
   reviewed only once. Rejection is also a single-use, audited decision.
5. After approval, the claimant completes a fresh Google authorization. The
   existing recovery resolver checks the exact account, subject, ciphertext,
   expiry, and identity conflicts. The existing OAuth persistence transaction
   re-encrypts the profile and stores the fresh grant and authorization code
   together. A failed or interrupted transaction leaves the old ciphertext,
   account ID, and billing rows unchanged. Completion has a separate
   single-use database claim.
6. The claimant signs in and reconnects Classroom/ChatGPT if the relevant
   grants need renewal. Recovery does not automatically restore lost Google
   grants or write grades.

## Data, audit, and limits

- Recovery sessions expire after 30 minutes; claimant requests expire after 7
  days; approved reconnect requests expire after 24 hours.
- Stable Google subjects and evidence references are encrypted at rest; their
  lookup/audit fingerprints use purpose-specific HMAC keys. No email is stored
  in the recovery intake.
- Owner approvals and rejections create admin audit entries. The decision
  claim table prevents a second review action. The existing completion claim
  prevents reuse of an approved recovery.
- Original account IDs, payment history, trial records, subscriptions, and
  entitlement rows are preserved. No recovery path changes those records.
- A subject already bound to another visible account, multiple requests,
  changed ciphertext, suspended/deleted account, or ambiguous evidence stops
  recovery. The owner must resolve the conflict through a separately verified
  process; never merge accounts or move subscriptions.
- If old ciphertext cannot be decrypted with the configured key, its former
  profile and old encrypted Google grants cannot be restored by this flow.
  Recovery requires independent ownership evidence and a fresh authorization.

## Validation boundary

The isolated Worker/D1 tests exercise recovery-only Google callback handling,
owner-role authorization, request submission, owner approval/rejection,
audit and one-time claims, recovery completion through the existing OAuth
transaction, expiry, interruption rollback, and billing preservation. They use
synthetic records and an injected Google identity test seam. They do not prove
production encryption-key compatibility, live Google consent, production D1
migration safety, Worker v22 parity, or production rollback. Production remains
unchanged and deployment remains separately gated.
