# Runtime Verification

## Result

**PASS — 2026-09-05**

The runtime was executed with Node.js 20.19.4 against a local Mock GitHub API. No real token or remote repository was used during this test.

## Verified

- Node syntax checks for `server.mjs` and `smoke-test.mjs`.
- `GET /api/health`.
- GitHub repository allowlist filtering.
- Arabic merge plan creation.
- Pull Request read through the GitHub provider.
- Successful CI verification.
- Protected branch verification.
- Squash merge execution after approval.
- One-time approval replay rejection.
- Failed CI rejection.
- Unprotected branch rejection.
- CLI Registry execution with `git.status`.
- Free-form CLI argument rejection.
- Workspace boundary rejection.
- Disallowed repository rejection.
- Ledger fields and successful execution trace.

## Reproduction

From `outputs/arabic-devops-mvp/`:

```bash
node smoke-test.mjs
```

Expected result:

```text
{"status":"PASS"}
```

This is a provider/runtime integration test with a local mock. A real GitHub end-to-end test still requires a limited `GITHUB_TOKEN` and a repository configured with the required branch protection.

`real-github-e2e.mjs` is included for that gate. It fails closed when `GITHUB_TOKEN` or the required dedicated test fixtures are absent, and it was not run against GitHub from this workspace.
