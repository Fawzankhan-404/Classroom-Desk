# Encrypted-record compatibility check

`scripts/verify-encrypted-records.mjs` checks the production envelope formats
without connecting to a database. It accepts a locally protected JSON snapshot
with two arrays:

```json
{
  "profiles": [{ "ciphertext": "v1.<iv>.<tag>.<body>" }],
  "oauthRecords": [{
    "kind": "grant",
    "key_hash": "<64 lowercase hex characters>",
    "payload": "v1.<iv>.<tag>.<body>"
  }]
}
```

The verifier uses the same key contract and derivation labels as the Worker:
`V2_PUBLIC_AUTH_ENCRYPTION_KEY_B64` is canonical base64 for a 32-byte root;
profile and OAuth payload keys use their respective HKDF-SHA256 labels; OAuth
records also authenticate the `kind:key_hash` value as AES-256-GCM AAD. It
validates the profile fields and parses OAuth JSON in memory, then clears the
mutable key/plaintext buffers. It prints only PASS/FAIL and successful/total
record counts. A PASS requires at least one valid profile and one valid OAuth
record; empty categories fail closed.

The input shape is strict. Profile rows may contain only `ciphertext`; OAuth
rows may contain only `kind`, `key_hash`, and `payload`; the root object may
contain only `profiles` and `oauthRecords`. This prevents accidentally passing
plaintext profile, token, or unrelated database fields to the verifier.
JavaScript strings and parsed objects are managed by the runtime and cannot be
reliably zeroized; use a protected local process and do not treat this as an
in-place database migration tool.

## Owner-invoked procedure

Use a protected offline copy and a local file with restrictive permissions.
Do not put a key in command history, command arguments, a report, or a log. Set
the environment variable through the owner-approved local secret mechanism,
then run:

```powershell
node scripts/verify-encrypted-records.mjs C:\protected\classroom-desk-encrypted-snapshot.json
```

The script does not export records, contact Cloudflare, alter a database, or
write the snapshot. Remove the local snapshot using the approved protected-data
handling procedure after verification. This command has not been run against
production records. Synthetic-key tests do not establish that the production
key is available or compatible.

The snapshot must be prepared by an independently approved procedure that
returns only the encrypted `profile_ciphertext` and OAuth envelope fields; it
must not include account IDs, emails, names, tokens, or other unrelated columns.
The verifier does not prove provenance of the key. The owner must establish
that the supplied key is the exact key bound to the active production Worker
before interpreting a PASS as production compatibility.
