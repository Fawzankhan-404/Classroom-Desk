# Connect Classroom Desk to ChatGPT

Classroom Desk connects Google Classroom to ChatGPT through its authenticated MCP service. Google permissions and the signed-in account determine which Classroom data is available.

## Connect

1. Sign in at [Classroom Desk](https://classroom.jarvis404.com/) with Google.
2. Choose Student or Teacher. Student is the default; this preference does not grant teacher permissions.
3. Connect Google Classroom when prompted and approve the permissions Google displays.
4. Add the canonical MCP endpoint `https://classroom.jarvis404.com/mcp` in ChatGPT if custom MCP connections are available in your workspace.
5. Ask ChatGPT to list courses and work available to your Google account.

For local or self-hosted use, configure the MCP URL and matching OAuth client for your own installation. Keep those settings separate from the public service.

## Access boundaries

- ChatGPT can access only information authorized for the connected Google account.
- Selecting Teacher changes the dashboard preference, not Google Classroom roles or API scopes.
- Teacher-only data requires verified Google authorization and course permissions.
- Assessment records in the demonstration are synthetic. Approving a demo draft does not write a grade to Google Classroom.

## Troubleshooting

- If the MCP connection is unavailable, verify the canonical website and `/mcp` connection configuration.
- If Google authorization expired, reconnect through the normal OAuth flow.
- If a course is missing, confirm the connected Google account and its actual Classroom membership.
- Never share OAuth codes, session cookies, or tokens in support requests.
