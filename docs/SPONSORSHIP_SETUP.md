# Support payment setup status

## Verified in this task

- The connected Razorpay dashboard contains no payment page titled “Support Classroom Desk.” An unrelated payment page is inactive.
- The dashboard surfaced a live-mode control, but the connected read-only integration cannot inspect merchant KYC or account eligibility. The account's company-registration view did not expose a completed verification status during this check.
- Razorpay's public material describes Payment Pages as supporting configurable pages and variable donation amounts. That does not establish this merchant's eligibility to collect voluntary open-source project contributions.
- No approved, active Razorpay support URL is available. `.github/FUNDING.yml` must remain absent until the owner verifies and approves the hosted URL.

## Proposed page configuration for owner review

- **Title:** Support Classroom Desk
- **Brand:** existing `assets/classroom-desk-main-logo.svg`; dark navy with the project's cyan and emerald accents.
- **Description:** “Support the ongoing maintenance, hosting, infrastructure, documentation, and future development of Classroom Desk, a free and open-source project. Contributions are optional and do not unlock features or change account access.”
- **Suggested one-time amounts:** ₹99, ₹299, and ₹999. Enable customer-defined INR amount only if the verified Payment Page configuration offers it for this account.
- **Supporter details:** keep only provider-required checkout fields; add no project-specific personal data fields.
- **Thank-you message:** “Thank you for supporting Classroom Desk. Your voluntary contribution helps us maintain and improve this free, open-source project.”
- **Publishing:** draft only after merchant eligibility is confirmed; show the exact preview and resulting hosted URL for owner approval before publication.

## Owner actions required

1. In the Razorpay Dashboard, confirm account activation, KYC completion, and **Live Mode** eligibility. Ask Razorpay Support to confirm that voluntary contributions for maintaining an independent open-source software project are permitted for this merchant/account category. Keep that confirmation in the merchant dashboard or support correspondence.
2. Once eligibility is confirmed, create a draft Payment Page named **Support Classroom Desk**. Use the Classroom Desk logo/brand colors, a short purpose statement, and a thank-you message. Configure voluntary INR amounts ₹99, ₹299, and ₹999, plus a customer-defined amount if the page supports it. Collect only the minimum checkout data Razorpay requires.
3. Review the draft configuration and share its preview with the project owner. **Do not publish it until the owner approves the exact configuration and URL.** Do not run a test or real contribution as part of link verification.
4. After owner approval and publication, verify the hosted URL while signed out and confirm it belongs to the intended merchant. Then add that URL to the website, README, and `.github/FUNDING.yml` using only the supported `custom:` field. Do not add an inactive GitHub Sponsors or Buy Me a Coffee destination.
5. Run the focused public-page, accessibility, link, and regression checks. Keep all payment links outside Google OAuth and ChatGPT connector flows.

## Project promise

Classroom Desk remains free and open source. Contributions are voluntary and help with maintenance, hosting, infrastructure, documentation, and future development; they do not unlock features, purchase hosted-plan access, or change permissions. Do not describe Classroom Desk as a charity or promise tax deductions.
