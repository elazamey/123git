import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = await mkdtemp(join(tmpdir(), "arabic-devops-mvp-"));
const repoRoot = join(tempRoot, "repo");
let runtime;
let mock;

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${stderr}`)));
  });
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text };
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await request(url);
      if (response.status === 200) return response;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Runtime did not start: ${url}`);
}

await mkdir(repoRoot, { recursive: true });
await run("git", ["init", "-q", repoRoot], tempRoot);

mock = http.createServer((req, res) => {
  const path = new URL(req.url, "http://mock").pathname;
  if (req.method === "GET" && path === "/user/repos") return send(res, 200, [{ owner: { login: "acme" }, name: "storefront" }]);
  const prMatch = path.match(/^\/repos\/acme\/storefront\/pulls\/(\d+)$/);
  if (req.method === "GET" && prMatch) {
    const number = Number(prMatch[1]);
    return send(res, 200, { number, state: "open", mergeable: true, mergeable_state: "clean", head: { sha: `sha-${number}` }, base: { ref: number === 14 ? "unprotected" : "main" }, html_url: `https://github.com/acme/storefront/pull/${number}` });
  }
  const checksMatch = path.match(/^\/repos\/acme\/storefront\/commits\/sha-(\d+)\/check-runs$/);
  if (req.method === "GET" && checksMatch) {
    const number = Number(checksMatch[1]);
    return send(res, 200, { check_runs: [{ name: "CI / test", status: "completed", conclusion: number === 13 ? "failure" : "success" }] });
  }
  const protectionMatch = path.match(/^\/repos\/acme\/storefront\/branches\/([^/]+)\/protection$/);
  if (req.method === "GET" && protectionMatch) {
    if (decodeURIComponent(protectionMatch[1]) === "unprotected") return send(res, 404, { message: "Branch not protected" });
    return send(res, 200, { required_status_checks: { contexts: ["CI / test"] } });
  }
  const mergeMatch = path.match(/^\/repos\/acme\/storefront\/pulls\/(\d+)\/merge$/);
  if (req.method === "PUT" && mergeMatch) return send(res, 200, { merged: true, sha: `merge-${mergeMatch[1]}` });
  return send(res, 404, { message: "mock route not found" });
});

try {
  const mockPort = await listen(mock);
  const runtimePort = await new Promise(resolve => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  runtime = spawn(process.execPath, [join(here, "server.mjs")], {
    cwd: here,
    env: {
      ...process.env,
      PORT: String(runtimePort),
      GITHUB_TOKEN: "test-token",
      GITHUB_API_BASE: `http://127.0.0.1:${mockPort}`,
      GITHUB_REPOSITORY: "acme/storefront",
      GITHUB_ALLOWED_REPOSITORIES: "acme/storefront",
      WORKSPACE_ROOT: repoRoot,
      AGENT_ACTOR_ID: "smoke-test"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const base = `http://127.0.0.1:${runtimePort}`;
  await waitFor(`${base}/api/health`);

  const health = await request(`${base}/api/health`);
  assert.equal(health.json.githubConfigured, true);
  assert.equal(health.json.allowlistConfigured, true);

  const repos = await request(`${base}/api/github/repos`);
  assert.equal(repos.status, 200);
  assert.equal(repos.json[0].full_name, undefined);
  assert.equal(repos.json[0].name, "storefront");

  const planResponse = await request(`${base}/api/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "ادمج PR رقم 12 إذا كانت اختبارات CI ناجحة", repository: "acme/storefront", prNumber: 12 }) });
  assert.equal(planResponse.status, 200);
  assert.equal(planResponse.json.state, "WAITING_APPROVAL");
  assert.ok(planResponse.json.approvalId);

  const merged = await request(`${base}/api/approvals/${planResponse.json.approvalId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }) });
  assert.equal(merged.status, 200);
  assert.equal(merged.json.state, "COMPLETED");
  assert.equal(merged.json.result.checksVerified, true);
  assert.equal(merged.json.result.branchPolicyVerified, true);

  const replay = await request(`${base}/api/approvals/${planResponse.json.approvalId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }) });
  assert.equal(replay.status, 404);

  const failedCiPlan = await request(`${base}/api/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "ادمج PR رقم 13", repository: "acme/storefront", prNumber: 13 }) });
  const failedCi = await request(`${base}/api/approvals/${failedCiPlan.json.approvalId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }) });
  assert.equal(failedCi.status, 409);

  const unprotectedPlan = await request(`${base}/api/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "ادمج PR رقم 14", repository: "acme/storefront", prNumber: 14 }) });
  const unprotected = await request(`${base}/api/approvals/${unprotectedPlan.json.approvalId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }) });
  assert.equal(unprotected.status, 409);

  const cli = await request(`${base}/api/tools/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "git.status", cwd: repoRoot }) });
  assert.equal(cli.status, 200);
  assert.equal(cli.json.exitCode, 0);
  const freeArgs = await request(`${base}/api/tools/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "git.status", args: ["--ignored"], cwd: repoRoot }) });
  assert.equal(freeArgs.status, 400);
  const escapedPath = await request(`${base}/api/tools/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "git.status", cwd: tempRoot }) });
  assert.equal(escapedPath.status, 403);

  const disallowed = await request(`${base}/api/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "اعرض PR رقم 1", repository: "evil/repo", prNumber: 1 }) });
  assert.equal(disallowed.status, 403);

  const ledger = await request(`${base}/api/ledger`);
  assert.equal(ledger.status, 200);
  const success = ledger.json.entries.find(entry => entry.type === "EXECUTION" && entry.result === "SUCCESS");
  assert.ok(success);
  assert.equal(success.actor, "smoke-test");
  assert.equal(success.repository, "acme/storefront");
  assert.equal(success.requestedAction, "squash_merge");
  assert.equal(success.checksVerified, true);
  assert.equal(success.branchPolicyVerified, true);

  console.log(JSON.stringify({ status: "PASS", checks: ["health", "allowlist", "plan", "github-pr", "ci", "branch-protection", "merge", "approval-replay", "cli-registry", "path-boundary", "ledger"] }, null, 2));
} finally {
  if (runtime) runtime.kill("SIGTERM");
  if (mock) await new Promise(resolve => mock.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
}
