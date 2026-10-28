# Flightdeck → GitHub coding-agent issue handoff

**Optional and disabled by default.** An agent investigation may propose an action, but it must be **approved by an administrator** separately before Flightdeck can create a corresponding GitHub issue.

The handoff creates a GitHub *issue*, **not** code, a pull request, a workflow run, a deployment, or a Flagship rollout change.

## Account-owned configuration

Configure the Flightdeck Console Worker:

- `GITHUB_REPOSITORY=owner/repo` as an explicit single-repository allowlist (not browser input).
- `GITHUB_ISSUES_TOKEN` via `wrangler secret put`. Use a fine-grained token or GitHub App installation token with **Issues: write** only on the target repository; do not give it Contents: write or Actions: write. Keep secrets out of source and environment manifests.
- Cloudflare Access and `ADMIN_EMAILS` must already be configured, with D1 migration `0006_agent_handoffs.sql` applied.

## User workflow

1. A verified administrator reviews a Flightdeck investigation and approves a specific proposed action, with rationale.
2. The administrator explicitly chooses **Create GitHub issue** in the Flightdeck UI and confirms the target action.
3. `POST /api/proposed-actions/:id/handoff` with same-origin request and `{"confirm":"CREATE_ISSUE"}`.
4. The Console checks Access identity, admin allowlist, action state and project scope, then atomically claims the one-time handoff in D1.
5. It sends a bounded issue title/body with a unique, visible-to-operators HTML marker, the original summary and acceptance criteria. The generated issue explicitly identifies itself as an untrusted AI-assisted engineering proposal.
6. Successful GitHub `201` responses are stored as an issue URL, with a separate audit entry.

The endpoint **does not automatically retry** once it has claimed creation. A network timeout could occur after GitHub creates an issue. In that case D1 records `uncertain`; the operator must search the configured repository for the action marker before manually reconciling. The retry guard prevents accidental duplicate side effects.

## Security model

- Never accept arbitrary GitHub owner/repo from HTTP requests.
- Never accept arbitrary issue title/body or shell commands from HTTP requests.
- No GitHub token in an event property, frontend JavaScript, query, audit log, or response.
- No write/delete controls exposed through Flightdeck's MCP server.
- An issue represents a **work item proposal**; a coding agent needs its own authorized workflow and repository permissions to act on it.
- Human review, CI, approvals and release policy remain mandatory.
- This operation requires live GitHub API and Cloudflare integration tests in the separate workspace before production use.
