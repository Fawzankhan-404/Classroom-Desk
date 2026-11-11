# Support payment setup status

## Implementation status (2026-11-11)

- The production support page provides direct email and GitHub links. It has no in-site support form; email composition depends on the visitor's configured mail app, and Classroom Desk does not receive or claim delivery of messages.
- A separate, default-off Razorpay contribution path is prepared in source. It uses a dedicated test key pair and webhook secret, a verified maximum amount, separate D1 order/event records, and no subscription or entitlement writes.
- The supported test-mode choices are ₹49, ₹99, ₹199, ₹499, and custom INR from ₹10 through an explicitly configured account maximum. The maximum must be read from the merchant account; this document does not invent one.
- Contributions remain unavailable unless a verified Razorpay test account has been configured, the dedicated test enable flag is explicitly set, and migration `0017_voluntary_contributions.sql` has been applied to the intended database.
- Do not copy subscription Razorpay credentials into the contribution configuration. Production contributions are not implemented or enabled by this candidate.
- On 2026-11-11, the authenticated Razorpay dashboard showed Live Mode and account access as active, with activation dated Aug 01 2026. This does not establish KYC completion or eligibility to accept voluntary open-source contributions.
- The dashboard's approved website entry is `https://courses.jarvis404.com/`, which does not match Classroom Desk production at `https://classroom.jarvis404.com/`. The webhook settings list an enabled Classroom Desk subscription endpoint at `https://classroom.jarvis404.com/webhooks/razorpay` and a separate `courses.jarvis404.com` endpoint. No contribution checkout or payment was initiated.
- Razorpay's Add additional website/app flow states the existing website remains active and an additional site must follow the same business model; a different model requires a separate Razorpay account. The registered public site identifies as an AI Developer Bootcamp, while the proposed Classroom Desk flow is voluntary open-source contributions. Compatibility is not established, so no additional site was submitted.

## Verified in the 2026-11-11 dashboard inspection

- The authenticated dashboard was in Live Mode and showed account access as complete. A live API key was present; its value is intentionally not recorded here.
- The dashboard listed two enabled webhooks: Classroom Desk's existing subscription endpoint (`/webhooks/razorpay`, 11 configured events) and the separate `courses.jarvis404.com` endpoint (46 configured events). It did not list the contribution endpoint `/webhooks/razorpay/contributions`. No payment was initiated.
- The approved website entry did not match the Classroom Desk production hostname. The dashboard evidence does not establish that this hostname is approved.
- The dashboard's additional-site form explicitly requires the same business model and says a different business model needs a separate account. The registered `courses.jarvis404.com` site publicly identifies as an AI Developer Bootcamp; whether the proposed Classroom Desk contribution flow qualifies as the same model is unresolved. No new account or website entry was created.
- Merchant eligibility for collecting voluntary contributions to an independently maintained open-source software project, KYC completion, and applicable transaction limits remain unverified. Account activation alone is not proof of any of these.
- No approved, active Razorpay support URL is available. `.github/FUNDING.yml` must remain absent until the owner verifies and approves the hosted URL.

## Proposed page configuration for owner review

- **Title:** Support Classroom Desk
- **Brand:** existing `assets/classroom-desk-main-logo.svg`; dark navy with the project's cyan and emerald accents.
- **Description:** “Support the ongoing maintenance, hosting, infrastructure, documentation, and future development of Classroom Desk, a free and open-source project. Contributions are optional and do not unlock features or change account access.”
- **One-time amounts:** ₹49, ₹99, ₹199, ₹499, and a custom INR amount with a ₹10 minimum. The upper limit must match a value verified in the merchant account.
- **Supporter details:** keep only provider-required checkout fields; add no project-specific personal data fields.
- **Thank-you message:** “Thank you for supporting Classroom Desk. Your voluntary contribution helps us maintain and improve this free, open-source project.”
- **Publishing:** draft only after merchant eligibility is confirmed; show the exact preview and resulting hosted URL for owner approval before publication.

## Owner actions required

1. Ask Razorpay Support to confirm whether voluntary contributions for maintaining an independent open-source software project can be collected under this merchant/account category and whether Classroom Desk is the same business model as the registered AI Developer Bootcamp site. The dashboard says an additional site must share the existing business model or use a separate account. Also clarify applicable transaction limits. Live Mode and account access were active, but KYC completion and contribution eligibility were not verified; activation is not contribution approval.
2. Once eligibility is confirmed, the owner can choose between the isolated website checkout implementation and a Razorpay Payment Page. Do not publish or enable either until the exact configuration and destination have been reviewed and approved. If using a Payment Page, use voluntary INR amounts ₹49, ₹99, ₹199, and ₹499, with a custom amount of at least ₹10 where the account supports it; set the maximum from verified account limits.
3. For website checkout, first configure separate test credentials, webhook secret, explicit test-mode flag, and the verified order maximum. Apply migration 0017 only to the correct environment. Run mocked regression tests, then a Razorpay test-mode checkout using provider test credentials; do not enter real card details or activate live mode.
4. Review the checkout or page preview and the exact support copy. Keep all contribution links outside Google OAuth and ChatGPT connector flows. No production deployment, production migration, published Payment Page, or live charge is authorized by this setup note.
5. Before enabling any production contribution flow, verify the Classroom Desk hostname is approved, contribution eligibility and amount limits are confirmed, separate live contribution credentials and a contribution webhook for `/webhooks/razorpay/contributions` are configured, and callback behavior is tested; then obtain explicit owner approval for the exact release and activation. The existing subscription webhook does not cover or verify contribution webhook handling.

## Project promise

Classroom Desk remains free and open source. Contributions are voluntary and help with maintenance, hosting, infrastructure, documentation, and future development; they do not unlock features, purchase hosted-plan access, or change permissions. Do not describe Classroom Desk as a charity or promise tax deductions.
