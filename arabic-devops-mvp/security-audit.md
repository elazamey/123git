# Security Audit

## Findings Fixed

- **Approval replay / bypass:** approval handles are separate one-use `approvalId` values. The endpoint requires an exact `approved` boolean, a matching plan, and `WAITING_APPROVAL` state. Verification runs again inside the approval path before merge. Completed, blocked, cancelled, and running plans cannot be approved again.
- **Weak audit context:** every ledger entry now carries `actor`, `planId`, `approvalId`, `intent`, `repository`, `pullRequest`, `requestedAction`, `risk`, `checksVerified`, and `branchPolicyVerified`. The actor is server configuration, not a client-supplied field.
- **Repository scope:** GitHub operations require `GITHUB_ALLOWED_REPOSITORIES`. Repository names are validated and checked before planning, reading a PR, or merging.
- **Workspace scope:** CLI execution resolves the configured workspace and requested directory with `realpath`, preventing traversal and symlink escapes.
- **Command scope:** CLI names and arguments come only from `CLI_REGISTRY`; request-provided arguments are rejected and `shell: false` remains enabled.
- **Resource limits:** request bodies are capped at 64 KiB, command output is capped at 64 KiB, commands time out after 30 seconds, and API requests have a small in-memory rate limit.

## Remaining Production Risks

- There is no OAuth or GitHub App identity yet; `AGENT_ACTOR_ID` is a local configured identity.
- Plans live in memory and the ledger is append-only JSONL, not a transactional database.
- There is no authenticated browser session or CSRF token flow yet.
- Branch protection is verified as present, but required review/check rules are not yet compared with the plan.
- The current environment has no Node.js runtime, so the server could not be started here; frontend behavior was validated in the browser.
