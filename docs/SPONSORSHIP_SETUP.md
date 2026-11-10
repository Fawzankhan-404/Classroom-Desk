# Support payment setup status

## Implementation status (2026-11-10)

- The support page now has a validated message composer that opens the visitor’s email app. Classroom Desk does not receive or claim delivery of that message.
- A separate, default-off Razorpay contribution path is prepared in source. It uses a dedicated test key pair and webhook secret, a verified maximum amount, separate D1 order/event records, and no subscription or entitlement writes.
- The supported test-mode choices are ₹49, ₹99, ₹199, ₹499, and custom INR from ₹10 through an explicitly configured account maximum. The maximum must be read from the merchant account; this document does not invent one.
- Contributions remain unavailable unless a verified Razorpay test account has been configured, the dedicated test enable flag is explicitly set, and migration `0017_voluntary_contributions.sql` has been applied to the intended database.
- Do not copy subscription Razorpay credentials into the contribution configuration. Live-mode contributions are not implemented or enabled by this candidate.
- The live/test merchant mode, account activation, KYC status, permitted merchant category, and configured per-order maximum have not been verified from the Razorpay dashboard in this run. No payment has been initiated.

## Verified in this task

- The connected Razorpay dashboard contains no payment page titled “Support Classroom Desk.” An unrelated payment page is inactive.
- The dashboard surfaced a live-mode control, but the connected read-only integration cannot inspect merchant KYC or account eligibility. The account's company-registration view did not expose a completed verification status during this check.
- Razorpay's public material describes Payment Pages as supporting configurable pages and variable donation amounts. That does not establish this merchant's eligibility to collect voluntary open-source project contributions.
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

1. In the Razorpay Dashboard, confirm account activation, KYC completion, and **Live Mode** eligibility. Ask Razorpay Support to confirm that voluntary contributions for maintaining an independent open-source software project are permitted for this merchant/account category. Keep that confirmation in the merchant dashboard or support correspondence.
2. Once eligibility is confirmed, the owner can choose between the isolated website checkout implementation and a Razorpay Payment Page. Do not publish or enable either until the exact configuration and destination have been reviewed and approved. If using a Payment Page, use voluntary INR amounts ₹49, ₹99, ₹199, and ₹499, with a custom amount of at least ₹10 where the account supports it; set the maximum from verified account limits.
3. For website checkout, first configure separate test credentials, webhook secret, explicit test-mode flag, and the verified order maximum. Apply migration 0017 only to the correct environment. Run mocked regression tests, then a Razorpay test-mode checkout using provider test credentials; do not enter real card details or activate live mode.
4. Review the checkout or page preview and the exact support copy. Keep all contribution links outside Google OAuth and ChatGPT connector flows. No production deployment, production migration, published Payment Page, or live charge is authorized by this setup note.
5. Before enabling any production contribution flow, verify account activation, merchant eligibility, live credentials, webhook configuration, amount limits, and callback behavior in the authenticated Razorpay dashboard; then obtain explicit owner approval for the exact release and activation.

## Project promise

Classroom Desk remains free and open source. Contributions are voluntary and help with maintenance, hosting, infrastructure, documentation, and future development; they do not unlock features, purchase hosted-plan access, or change permissions. Do not describe Classroom Desk as a charity or promise tax deductions.
