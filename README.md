<div align="center">
  <img src="assets/classroom-desk-main-logo.svg" width="370" alt="Classroom Desk">

  <p><strong>Your Google Classroom. Smarter with ChatGPT.</strong></p>
  <p>A free, open-source assistant for working with your own Google Classroom in ChatGPT.</p>

  <p>
    <a href="https://classroom.jarvis404.com"><strong>Open Classroom Desk</strong></a> ·
    <a href="docs/GETTING_STARTED.md">Get started</a> ·
    <a href="docs/CHATGPT_CONNECTION_GUIDE.md">Connect ChatGPT</a> ·
    <a href="CONTRIBUTING.md">Contribute</a>
  </p>

  <p>
    <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/License-Apache--2.0-2f6f4e?style=flat-square"></a>
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white">
    <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white">
    <img alt="Model Context Protocol" src="https://img.shields.io/badge/Model_Context_Protocol-MCP-635BFF?style=flat-square">
  </p>
</div>

---

## About

Classroom Desk connects your Google account to ChatGPT through Google OAuth and the Model Context Protocol (MCP). It helps you find and review the Classroom information that your account is authorized to access.

The project includes **Student** and **Teacher** dashboard preferences. Student is the default. Teacher mode currently contains a synthetic assessment demo; choosing it does not grant Google teacher permissions or reveal real class submissions.

Classroom Desk is open-source software. Running a self-hosted copy may incur charges from infrastructure or service providers. The hosted website has its own service terms.

## What you can do

| Experience | Included | Access boundary |
|---|---|---|
| Student | View supported courses, coursework, deadlines, announcements, activity, and your submission status through authenticated tools. | Google permissions and course membership determine available data. Classroom changes are not made. |
| Teacher | Explore a rubric and six sample responses with evidence-based draft marks, review flags, and demo approval. | All records are synthetic and labeled DEMO. Approval is local to the demo. |
| Gradebook | No grade writeback is included. | Demo marks are never sent to Google Classroom. |

Teacher dashboard selection is a display preference only. Live teacher rosters and submissions require verified teacher authorization and are not part of the synthetic demo.

## Use Classroom Desk

1. Sign in at [classroom.jarvis404.com](https://classroom.jarvis404.com/) with Google.
2. Choose Student or Teacher. Student is selected by default; you can switch later in the dashboard.
3. Connect Classroom when prompted and review the permissions Google displays.
4. Connect Classroom Desk to ChatGPT if custom MCP connections are available in your workspace.
5. Ask ChatGPT for information available to your connected Google account.

See the [ChatGPT connection guide](docs/CHATGPT_CONNECTION_GUIDE.md) for details. ChatGPT workspace plan and administrator settings can affect custom MCP availability.

## Run locally

**Requirements:** Node.js 20 or later and npm.

```bash
git clone https://github.com/Fawzankhan-404/Classroom-Desk.git
cd Classroom-Desk
npm ci
```

Copy `.env.example` to `.env`, then configure a dedicated development Google OAuth client and local data store. Keep credentials in the ignored `.env` file or a secret manager; never use production credentials for local development.

```bash
npm run check
npm test
npm run build
npm run start:http
```

The automated suite uses synthetic data. `npm run build:worker` is a Wrangler dry run and does not deploy. Read [Getting started](docs/GETTING_STARTED.md) and [Self-hosting](docs/SELF_HOSTING.md) before configuring a live Google account or deployment.

## Configuration and security

Use [.env.example](.env.example) as a list of configuration names and placeholders. Supply your own OAuth client, database, and encryption settings for the environment you operate. Do not commit `.env`, `.dev.vars`, OAuth client files, database backups, tokens, or secret-manager exports.

Google sign-in, Google Classroom authorization, and the dashboard preference are separate. Classroom access is limited by the authenticated account and Google permissions. Synthetic assessment approval is not a real grade, and Google Classroom gradebook writeback is disabled.

To report a vulnerability, follow the private reporting instructions in [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please include focused tests for behavior changes and use synthetic data in issues, pull requests, and test fixtures. Do not attach student records, credentials, OAuth tokens, or production database exports.

## License

Classroom Desk source is available under the [Apache License 2.0](LICENSE). Third-party dependencies and assets remain subject to their respective licenses. See [NOTICE.md](NOTICE.md) for attribution details.

---

Built by **Mohammed Fawzan Khan**. Classroom Desk is an independent project and is not affiliated with or endorsed by Google or OpenAI.
