# Legacy account recovery

## State and safety rules

Migration 0013 adds an account-scoped `ready` / `recovery_pending` state and a
short-lived recovery request. A request stores only the stable Google subject
lookup hash, the fingerprint of the existing profile ciphertext, and a hash of
the independent review case reference. It does not store a new profile or an
OAuth token before Google authorization succeeds. The original account UUID,
legacy pairing row, payment history, subscriptions, trials, and entitlements
remain attached to the same account.

The public application does not expose a recovery-request endpoint. Recovery
creation requires an internal `LegacyRecoveryOwnershipProofVerifier`; it must
return the exact verified account UUID and stable Google subject, attest that
the reviewer is independent, and provide a case reference. Without that
explicitly configured verifier the operation fails closed. Do not enable or
expose this interface until the verifier is implemented, access-controlled,
and reviewed.

## Owner and support workflow

1. The user starts a fresh Google sign-in with the Google account they believe
   owns the existing Classroom Desk account. Google ID-token validation must
   verify issuer, audience, expiry, nonce, stable `sub`, and `email_verified`.
   Email is not an account-linking key.
2. If the stored profile cannot be decrypted, the sign-in does not create a
   second account or move entitlements. The account remains unavailable until
   recovery is approved.
3. A support reviewer verifies ownership using evidence independent of the
   current Google email (for example, a pre-existing account recovery case and
   independently controlled account evidence). The reviewer must not be the
   account owner. Email equality, a newly supplied email, or possession of the
   new Google session alone is insufficient. If evidence is ambiguous, stop
   and escalate; do not merge accounts.
4. The internal verifier issues a request bound to the original account UUID
   and verified Google `sub`. Requests expire within 24 hours. The review case
   reference is stored only as a hash. One account and one subject can each
   have only one pending request.
5. The user completes a fresh Google authorization. The callback must validate
   Google identity and the approved scopes and must receive a fresh refresh
   token. It does not decrypt or reuse an old-key OAuth grant. If Google does
   not return a refresh token, keep recovery pending and ask the user to
   re-consent through the supported offline-access flow; do not complete
   recovery with an access token alone.
6. In one database transaction/batch, the server checks that the original
   ciphertext is unchanged, that the subject still has exactly one approved
   request, and that account mappings are not claimed elsewhere. It then
   encrypts the verified profile and fresh OAuth grant with the configured key,
   stores the profile, mapping, grant, MCP authorization code, and one-time
   completion claim. A failure rolls all of these writes back. Repeated or
   expired callbacks cannot reuse the completed request.
7. The user signs in again and reconnects any Google/ChatGPT connection that
   needs fresh consent. Billing, subscriptions, historical payments, and the
   original account ID are not changed by this process.

## Manual intervention and limits

- No independently verifiable ownership evidence: leave the account pending
  and escalate to the owner. Never use email-only matching.
- A stable Google subject already bound to another account, multiple pending
  requests, a changed legacy ciphertext, conflicting legacy/unified MCP maps,
  or a suspended/deleted account: stop for manual investigation. Do not merge
  or transfer subscriptions.
- An old OAuth grant encrypted with an unavailable key cannot be decrypted or
  re-encrypted. Recovery requires a new Google authorization that returns a
  fresh refresh token. The old encrypted record is not read or copied by this
  flow; preserve backups under the existing retention policy.
- Migration 0013 and the service path are not production-authorized by this
  document. Production source compatibility, protected-record verification,
  D1 recovery, reviewer tooling, and owner release approval remain separate
  gates. Do not apply the migration or activate a replacement key in production
  until those gates pass.

## Verification boundary

Synthetic tests cover successful same-account recovery, wrong-account proof,
same-email/different-subject rejection, duplicate identity, ambiguous pending
requests, transaction interruption, and preservation of trial, subscription,
entitlement, and payment rows. These tests do not verify production ciphertext,
keys, Google consent, or live Cloudflare D1 behavior.
