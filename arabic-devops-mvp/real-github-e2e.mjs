import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const token = process.env.GITHUB_TOKEN || "";
const repository = process.env.GITHUB_REPOSITORY || "";
const allowlist = new Set((process.env.GITHUB_ALLOWED_REPOSITORIES || "").split(",").map(value => value.trim()).filter(Boolean));
const apiBase = (process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "");
const agentBase = (process.env.AGENT_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const prNumber = Number(process.env.E2E_PR_NUMBER || 0);
const failedCiPr = Number(process.env.E2E_FAILED_CI_PR || 0);
const unprotectedPr = Number(process.env.E2E_UNPROTECTED_PR || 0);
const unauthorizedRepository = process.env.E2E_UNAUTHORIZED_REPOSITORY || "";
const evidenceRoot = process.env.E2E_EVIDENCE_DIR || join(process.cwd(), "evidence", "real-github-e2e");
const execute = process.argv.includes("--execute");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = join(evidenceRoot, timestamp);
const scenarios = [];

function requireConfig() {
  assert(token, "GITHUB_TOKEN is required locally");
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), "GITHUB_REPOSITORY must be owner/repository");
  assert(allowlist.has(repository), "GITHUB_REPOSITORY must be in GITHUB_ALLOWED_REPOSITORIES");
  assert(prNumber > 0, "E2E_PR_NUMBER is required");
  assert(failedCiPr > 0, "E2E_FAILED_CI_PR is required for the negative CI case");
  assert(unprotectedPr > 0, "E2E_UNPROTECTED_PR is required for the negative branch case");
  assert(/^[\w.-]+\/[\w.-]+$/.test(unauthorizedRepository), "E2E_UNAUTHORIZED_REPOSITORY is required");
  assert(execute, "Refusing to merge without --execute");
  assert(process.env.E2E_CONFIRM_MERGE === "YES", "Set E2E_CONFIRM_MERGE=YES to authorize the test merge");
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text };
}

async function github(path, options = {}) {
  const response = await request(`${apiBase}${path}`, {
    ...options,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", ...options.headers }
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`GitHub API ${response.status}: ${response.json?.message || "request failed"}`);
    error.status = response.status;
    throw error;
  }
  return response.json;
}

async function agent(path, options = {}) {
  return request(`${agentBase}${path}`, { ...options, headers: { "content-type": "application/json", ...options.headers } });
}

function record(name, status, details = {}) {
  scenarios.push({ name, status, ...details });
  if (!(["PASS", "BLOCKED"].includes(status))) throw new Error(`${name}: ${details.error || status}`);
}

async function preflight(number) {
  const pr = await github(`/repos/${repository}/pulls/${number}`);
  assert.equal(pr.state, "open", `PR #${number} must be open`);
  const checks = await github(`/repos/${repository}/commits/${pr.head.sha}/check-runs`);
  let branchProtection = true;
  try { await github(`/repos/${repository}/branches/${encodeURIComponent(pr.base.ref)}/protection`); } catch (error) { if (error.status === 404) branchProtection = false; else throw error; }
  return { pr, checks, branchProtection };
}

async function createPlan(number, message = `ادمج PR رقم ${number} إذا كانت جميع اختبارات CI ناجحة`) {
  const response = await agent("/api/plan", { method: "POST", body: JSON.stringify({ message, repository, prNumber: number }) });
  assert.equal(response.status, 200, response.json?.error || response.text);
  assert.equal(response.json.state, "WAITING_APPROVAL");
  assert.ok(response.json.approvalId);
  return response.json;
}

async function approve(plan) {
  const response = await agent(`/api/approvals/${plan.approvalId}`, { method: "POST", body: JSON.stringify({ approved: true }) });
  return response;
}

async function negativePlan(number, label) {
  const plan = await createPlan(number);
  const response = await approve(plan);
  assert.equal(response.status, 409, response.json?.error || response.text);
  record(label, "BLOCKED", { httpStatus: response.status, error: response.json?.error || "policy blocked" });
}

async function writeEvidence(preflightData, ledger) {
  await mkdir(evidenceDir, { recursive: true });
  const summary = {
    gate: "REAL-GITHUB-E2E",
    generatedAt: new Date().toISOString(),
    repository,
    pullRequest: prNumber,
    mergeCommit: preflightData.pr.merge_commit_sha || null,
    headCommit: preflightData.pr.head.sha,
    requiredChecks: (preflightData.checks.check_runs || []).map(check => ({ name: check.name, status: check.status, conclusion: check.conclusion })),
    branch: preflightData.pr.base.ref,
    branchProtection: preflightData.branchProtection,
    node: process.version,
    agentUrl: agentBase,
    scenarios,
    ledgerEntries: ledger.entries?.length || 0,
    tokenRecorded: false
  };
  await writeFile(join(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(evidenceDir, "ledger.json"), JSON.stringify(ledger, null, 2));
  await writeFile(join(evidenceDir, "README.txt"), "Generated by real-github-e2e.mjs. No token is included.\n");
  return summary;
}

async function main() {
  requireConfig();
  const before = await preflight(prNumber);
  assert.ok((before.checks.check_runs || []).length > 0, "positive PR must have at least one CI check");
  assert.ok(before.checks.check_runs.every(check => check.status === "completed" && check.conclusion === "success"), "positive PR CI must be successful");
  assert.equal(before.branchProtection, true, "positive PR base branch must be protected");
  record("Real PR", "PASS", { number: prNumber });
  record("Real CI", "PASS", { checks: before.checks.check_runs.length });
  record("Branch Protection", "PASS", { branch: before.pr.base.ref });

  const plan = await createPlan(prNumber);
  const merged = await approve(plan);
  assert.equal(merged.status, 200, merged.json?.error || merged.text);
  assert.equal(merged.json.state, "COMPLETED");
  assert.equal(merged.json.result.checksVerified, true);
  assert.equal(merged.json.result.branchPolicyVerified, true);
  record("Approval + Re-verification", "PASS", { approvalId: plan.approvalId });
  const after = await github(`/repos/${repository}/pulls/${prNumber}`);
  assert.equal(after.merged, true, "positive PR was not merged");
  assert.equal(after.state, "closed");
  record("Real Squash Merge", "PASS", { mergeCommit: after.merge_commit_sha });

  const replay = await approve(plan);
  assert.equal(replay.status, 404, replay.json?.error || replay.text);
  record("Approval Replay", "BLOCKED", { httpStatus: replay.status });

  await negativePlan(failedCiPr, "CI Failure");
  await negativePlan(unprotectedPr, "Unprotected Branch");
  const unauthorized = await agent("/api/plan", { method: "POST", body: JSON.stringify({ message: "اعرض PR رقم 1", repository: unauthorizedRepository, prNumber: 1 }) });
  assert.equal(unauthorized.status, 403, unauthorized.json?.error || unauthorized.text);
  record("Repository خارج القائمة", "BLOCKED", { httpStatus: unauthorized.status });

  const ledger = await agent("/api/ledger");
  assert.equal(ledger.status, 200);
  const success = ledger.json.entries.find(entry => entry.type === "EXECUTION" && entry.result === "SUCCESS" && entry.approvalId === plan.approvalId);
  assert.ok(success, "successful execution evidence is missing from ledger");
  assert.equal(success.repository, repository);
  assert.equal(success.pullRequest, prNumber);
  assert.equal(success.requestedAction, "squash_merge");
  record("Ledger Evidence", "PASS", { entries: ledger.json.entries.length });
  const summary = await writeEvidence({ ...before, pr: after }, ledger.json);
  console.log(JSON.stringify({ status: "PASS", evidenceDir, scenarios: summary.scenarios }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(`REAL-GITHUB-E2E BLOCKED: ${error.message}`);
  process.exitCode = 1;
}
