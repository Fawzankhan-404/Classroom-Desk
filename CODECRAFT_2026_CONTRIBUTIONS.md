# CodeCraft 2026 contribution log

**Event date:** 17 October 2026. **Event start:** 10:00 IST, as supplied by the owner.

This log distinguishes repository state from claims about when work was authored. Git dates are not used as proof of event-time authorship where the working tree was uncommitted.

## Present in the development tree before this work session

- Existing Classroom Desk website, Google OAuth, MCP transports, student-focused Classroom tools, and Cloudflare Worker code.
- Student/Teacher selector and the six-record synthetic teacher assessment module were already present in the development tree at task start. No exact pre-event authorship timestamp is asserted.
- Earlier local assessment tests and demo scripts existed before this session; they are not reported as new event-time work.

## Added during this CodeCraft work session

- Free access evaluation for active linked accounts while retaining suspended and deleted account restrictions.
- Closed new trial, subscription, and payment-verification routes; retained the existing-subscription cancellation path and historical billing record handling.
- Removed public pricing and referral entry points from the active site flow, and updated public copy for free Student/Teacher onboarding.
- Added account-persisted dashboard selection and additive migration `0009_dashboard_preference.sql`.
- Added regression coverage for free MCP access, checkout retirement, preference persistence, and the teacher authorization boundary.
- Prepared open-source documentation and an Apache 2.0 license candidate.

## Demonstrated claims

- Synthetic rubric and six synthetic responses can be loaded in the local demo.
- Draft mark evidence is validated against the selected synthetic response.
- Missing and unreadable synthetic work is left unscored and requires review.
- Demo approval remains local, and gradebook writeback remains disabled.
- Test results describe local automated checks only. They do not establish fresh remote ChatGPT acceptance or production deployment.
