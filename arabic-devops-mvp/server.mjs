import http from "node:http";
import { appendFile, readFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, "..", "arabic-devops-agent.html");
const ledgerFile = join(here, "execution-ledger.jsonl");
const port = Number(process.env.PORT || 8787);
const githubToken = process.env.GITHUB_TOKEN || "";
const githubApiBase = (process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "");
const defaultRepo = process.env.GITHUB_REPOSITORY || "";
const workspaceRoot = resolve(process.env.WORKSPACE_ROOT || process.cwd());
const actorId = process.env.AGENT_ACTOR_ID || "local-user";
const allowedRepositories = new Set((process.env.GITHUB_ALLOWED_REPOSITORIES || defaultRepo).split(",").map(value => value.trim()).filter(Boolean));
const maxBodyBytes = 64 * 1024;
const maxOutputBytes = 64 * 1024;
const commandTimeoutMs = 30_000;
const rateWindowMs = 60_000;
const rateLimitMax = 60;
const requestBuckets = new Map();
const plans = new Map();
const approvals = new Map();

const CLI_REGISTRY = {
  "git.status": { bin: "git", args: ["status", "--short", "--branch"], risk: "READ_ONLY" },
  "git.log": { bin: "git", args: ["log", "-n", "10", "--oneline"], risk: "READ_ONLY" },
  "git.diff": { bin: "git", args: ["diff", "--stat"], risk: "READ_ONLY" },
  "gh.pr.list": { bin: "gh", args: ["pr", "list", "--limit", "10"], risk: "READ_ONLY" },
  "gh.run.list": { bin: "gh", args: ["run", "list", "--limit", "10"], risk: "READ_ONLY" }
};

class PolicyError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

function text(res, status, value, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", "x-frame-options": "DENY" });
  res.end(value);
}

async function bodyOf(req) {
  let raw = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (bytes > maxBodyBytes) throw new PolicyError("حجم الطلب أكبر من الحد المسموح", 413);
    raw += chunk;
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new PolicyError("الطلب ليس JSON صالحًا", 400); }
}

function arabicDigits(value) {
  return String(value || "").replace(/[٠-٩]/g, digit => "٠١٢٣٤٥٦٧٨٩".indexOf(digit));
}

function repoName(value, { requireAllowlist = true } = {}) {
  const repo = String(value || defaultRepo).trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new PolicyError("حدد المستودع بصيغة owner/repository", 400);
  if (requireAllowlist && (!allowedRepositories.size || !allowedRepositories.has(repo))) throw new PolicyError(`المستودع ${repo} غير موجود في GITHUB_ALLOWED_REPOSITORIES`, 403);
  return repo;
}

function record(event) {
  const item = {
    id: randomUUID(), timestamp: new Date().toISOString(), planId: null, approvalId: null,
    actor: actorId, intent: null, repository: null, pullRequest: null, requestedAction: null,
    risk: "UNKNOWN", checksVerified: null, branchPolicyVerified: null, ...event, actor: actorId
  };
  appendFile(ledgerFile, JSON.stringify(item) + "\n").catch(() => {});
  return item;
}

function rateAllowed(req) {
  const key = req.socket.remoteAddress || "local";
  const now = Date.now();
  const bucket = requestBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= rateWindowMs) { requestBuckets.set(key, { startedAt: now, count: 1 }); return true; }
  if (bucket.count >= rateLimitMax) return false;
  bucket.count += 1;
  return true;
}

async function github(path, options = {}) {
  if (!githubToken) throw new PolicyError("GITHUB_TOKEN غير مضبوط؛ تم إيقاف اتصال GitHub", 503);
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${githubToken}`, "x-github-api-version": "2022-11-28", ...options.headers };
  const response = await fetch(`${githubApiBase}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new PolicyError(payload.message || `GitHub API ${response.status}`, response.status);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function planFor(message, repository, prNumber) {
  const textValue = String(message || "");
  const mergeIntent = /دمج|ادمج|merge/i.test(textValue);
  const match = arabicDigits(textValue).match(/(?:PR|pull request|طلب السحب)?\s*#?\s*(\d+)/i);
  const number = Number(prNumber || (match && match[1]) || 0);
  const repo = repoName(repository || defaultRepo);
  if (mergeIntent && !number) throw new PolicyError("حدد رقم Pull Request قبل طلب الدمج", 400);
  const id = randomUUID();
  const approvalId = mergeIntent ? randomUUID() : null;
  const plan = {
    id,
    approvalId,
    state: mergeIntent ? "WAITING_APPROVAL" : "PLANNED",
    intent: mergeIntent ? "merge_pull_request" : "inspect_repository",
    repository: repo,
    pullRequest: number || null,
    risk: mergeIntent ? "REQUIRES_APPROVAL" : "READ_ONLY",
    createdAt: new Date().toISOString(),
    steps: mergeIntent ? [
      { tool: "github.get_pull_request", label: "قراءة تفاصيل Pull Request والفرع المستهدف", state: "PENDING" },
      { tool: "github.get_checks", label: "التحقق من جميع فحوصات CI", state: "PENDING" },
      { tool: "github.get_branch_protection", label: "التحقق من حماية الفرع وسياسة الدمج", state: "PENDING" },
      { tool: "policy.evaluate", label: "تقييم القابلية للدمج", state: "PENDING" },
      { tool: "github.merge_pull_request", label: "دمج PR بطريقة Squash بعد الموافقة", state: "PENDING" }
    ] : [
      { tool: "git.status", label: "قراءة حالة مساحة العمل", state: "PENDING" },
      { tool: "github.list_pull_requests", label: "قراءة Pull Requests المتاحة", state: "PENDING" }
    ]
  };
  plans.set(id, plan);
  if (approvalId) approvals.set(approvalId, id);
  record({ type: "PLAN_CREATED", intent: plan.intent, repository: plan.repository, pullRequest: plan.pullRequest, requestedAction: mergeIntent ? "squash_merge" : "inspect", risk: plan.risk, planId: id, approvalId });
  return plan;
}

function appendLimited(value, chunk) {
  const combined = `${value}${chunk}`;
  if (Buffer.byteLength(combined) <= maxOutputBytes) return { value: combined, truncated: false };
  return { value: Buffer.from(combined).subarray(0, maxOutputBytes).toString("utf8"), truncated: true };
}

function runCommand(spec, cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(spec.bin, spec.args, { cwd, shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "", stderr = "";
    let timedOut = false, stdoutTruncated = false, stderrTruncated = false, settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolveRun({ stdout, stderr, timedOut, stdoutTruncated, stderrTruncated, ...result }); };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, commandTimeoutMs);
    child.stdout.on("data", data => { const result = appendLimited(stdout, data); stdout = result.value; stdoutTruncated ||= result.truncated; });
    child.stderr.on("data", data => { const result = appendLimited(stderr, data); stderr = result.value; stderrTruncated ||= result.truncated; });
    child.on("close", exitCode => finish({ exitCode: exitCode ?? 1 }));
    child.on("error", error => finish({ stderr: `${stderr}${error.message}`, exitCode: 1 }));
  });
}

async function verifyAndMerge(plan) {
  if (!plan.pullRequest) throw new PolicyError("رقم Pull Request مطلوب قبل الدمج", 400);
  const repo = repoName(plan.repository);
  const basePath = `/repos/${repo}`;
  const pr = await github(`${basePath}/pulls/${plan.pullRequest}`);
  record({ type: "TOOL_RESULT", tool: "github.get_pull_request", intent: plan.intent, repository: repo, pullRequest: plan.pullRequest, requestedAction: "squash_merge", result: "SUCCESS", risk: "READ_ONLY", planId: plan.id, approvalId: plan.approvalId });
  if (pr.state !== "open") throw new PolicyError("Pull Request ليس مفتوحًا", 409);
  if (pr.mergeable !== true || ["blocked", "dirty"].includes(pr.mergeable_state)) throw new PolicyError("قابلية الدمج غير مؤكدة أو محظورة؛ تم منع الدمج", 409);
  const checks = await github(`${basePath}/commits/${pr.head.sha}/check-runs`);
  const checkRuns = checks.check_runs || [];
  const failed = checkRuns.filter(check => check.status !== "completed" || check.conclusion !== "success");
  if (!checkRuns.length) throw new PolicyError("لا توجد فحوصات CI مكتملة؛ تم منع الدمج", 409);
  if (failed.length) throw new PolicyError(`فشل ${failed.length} من فحوصات CI؛ تم منع الدمج`, 409);
  record({ type: "POLICY_CHECK", intent: plan.intent, repository: repo, pullRequest: plan.pullRequest, requestedAction: "squash_merge", result: "SUCCESS", checks: checkRuns.length, checksVerified: true, branchPolicyVerified: null, risk: "REQUIRES_APPROVAL", planId: plan.id, approvalId: plan.approvalId });
  let protection = { protected: false };
  try { await github(`${basePath}/branches/${encodeURIComponent(pr.base.ref)}/protection`); protection = { protected: true }; } catch (error) { if (error.status !== 404) throw error; }
  if (!protection.protected) {
    record({ type: "POLICY_CHECK", intent: plan.intent, repository: repo, pullRequest: plan.pullRequest, requestedAction: "squash_merge", result: "BLOCKED", checksVerified: true, branchPolicyVerified: false, target: pr.base.ref, risk: "REQUIRES_APPROVAL", planId: plan.id, approvalId: plan.approvalId });
    throw new PolicyError("الفرع المستهدف غير محمي؛ تم منع الدمج وفق سياسة MVP", 409);
  }
  record({ type: "POLICY_CHECK", intent: plan.intent, repository: repo, pullRequest: plan.pullRequest, requestedAction: "squash_merge", result: "SUCCESS", branchProtected: true, checksVerified: true, branchPolicyVerified: true, target: pr.base.ref, risk: "REQUIRES_APPROVAL", planId: plan.id, approvalId: plan.approvalId });
  const merged = await github(`${basePath}/pulls/${plan.pullRequest}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "squash" }), headers: { "content-type": "application/json" } });
  if (!merged.merged) throw new PolicyError(merged.message || "رفض GitHub عملية الدمج", 409);
  return { repo, pr, merged, checksVerified: true, branchPolicyVerified: true };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/") && !rateAllowed(req)) return json(res, 429, { error: "طلبات كثيرة؛ حاول بعد دقيقة" });
  try {
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, mode: "mvp", githubConfigured: Boolean(githubToken), allowlistConfigured: allowedRepositories.size > 0, workspaceConfigured: Boolean(process.env.WORKSPACE_ROOT), cliExecutor: "allowlist", approvalGate: true });
    if (req.method === "GET" && url.pathname === "/api/ledger") {
      let entries = [];
      try { entries = (await readFile(ledgerFile, "utf8")).trim().split("\n").filter(Boolean).slice(-100).map(line => JSON.parse(line)); } catch {}
      return json(res, 200, { entries });
    }
    if (req.method === "GET" && url.pathname === "/") return text(res, 200, await readFile(frontend, "utf8"), "text/html; charset=utf-8");
    if (req.method === "POST" && url.pathname === "/api/plan") {
      const input = await bodyOf(req);
      return json(res, 200, planFor(input.message, input.repository, input.prNumber));
    }
    if (req.method === "GET" && url.pathname === "/api/github/repos") {
      if (!allowedRepositories.size) throw new PolicyError("اضبط GITHUB_ALLOWED_REPOSITORIES قبل قراءة المستودعات", 503);
      const repos = await github("/user/repos?sort=updated&per_page=30");
      return json(res, 200, repos.filter(repo => allowedRepositories.has(`${repo.owner.login}/${repo.name}`)));
    }
    const prMatch = url.pathname.match(/^\/api\/github\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (req.method === "GET" && prMatch) {
      const repo = repoName(`${prMatch[1]}/${prMatch[2]}`);
      return json(res, 200, await github(`/repos/${repo}/pulls/${prMatch[3]}`));
    }
    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (req.method === "POST" && approvalMatch) {
      const approvalId = approvalMatch[1];
      const plan = plans.get(approvals.get(approvalId));
      if (!plan || plan.approvalId !== approvalId) throw new PolicyError("الموافقة غير موجودة أو انتهت صلاحيتها", 404);
      const input = await bodyOf(req);
      if (plan.state !== "WAITING_APPROVAL") throw new PolicyError(`الخطة ليست بانتظار موافقة: ${plan.state}`, 409);
      if (typeof input.approved !== "boolean") throw new PolicyError("أرسل approved كقيمة منطقية صريحة", 400);
      if (!input.approved) {
        plan.state = "CANCELLED";
        approvals.delete(approvalId);
        record({ type: "APPROVAL", approval: "DENIED", planId: plan.id, approvalId, intent: plan.intent, repository: plan.repository, pullRequest: plan.pullRequest, requestedAction: "squash_merge", risk: plan.risk });
        return json(res, 200, plan);
      }
      if (plan.risk !== "REQUIRES_APPROVAL" || plan.intent !== "merge_pull_request") throw new PolicyError("الخطة لا تملك مسار موافقة صالحًا", 403);
      plan.state = "RUNNING";
      record({ type: "APPROVAL", approval: "APPROVED", planId: plan.id, approvalId, intent: plan.intent, repository: plan.repository, pullRequest: plan.pullRequest, requestedAction: "squash_merge", risk: plan.risk });
      try {
        const result = await verifyAndMerge(plan);
        plan.state = "COMPLETED";
        plan.result = { merged: true, sha: result.merged.sha, url: result.pr.html_url, checksVerified: result.checksVerified, branchPolicyVerified: result.branchPolicyVerified };
        approvals.delete(approvalId);
        record({ type: "EXECUTION", intent: plan.intent, repository: result.repo, pullRequest: plan.pullRequest, requestedAction: "squash_merge", result: "SUCCESS", exitCode: 0, checksVerified: result.checksVerified, branchPolicyVerified: result.branchPolicyVerified, risk: plan.risk, planId: plan.id, approvalId });
        return json(res, 200, plan);
      } catch (error) {
        plan.state = "BLOCKED";
        plan.error = error.message;
        approvals.delete(approvalId);
        record({ type: "EXECUTION", intent: plan.intent, repository: plan.repository, pullRequest: plan.pullRequest, requestedAction: "squash_merge", result: "BLOCKED", exitCode: 1, checksVerified: false, branchPolicyVerified: false, risk: plan.risk, planId: plan.id, approvalId, error: error.message });
        throw error;
      }
    }
    if (req.method === "POST" && url.pathname === "/api/tools/execute") {
      const input = await bodyOf(req);
      const spec = CLI_REGISTRY[input.tool];
      if (!spec) throw new PolicyError("الأداة غير موجودة في Tool Registry", 404);
      if (spec.risk !== "READ_ONLY" && input.approved !== true) throw new PolicyError("الأداة تحتاج موافقة صريحة", 403);
      if (input.args !== undefined) throw new PolicyError("الحجج الحرة غير مسموحة؛ استخدم Tool Registry", 400);
      const configuredRoot = await realpath(workspaceRoot).catch(() => { throw new PolicyError("WORKSPACE_ROOT غير موجود أو غير قابل للقراءة", 500); });
      const cwdInput = String(input.cwd || configuredRoot);
      if (cwdInput.length > 512) throw new PolicyError("مسار التنفيذ طويل أكثر من اللازم", 400);
      const cwd = await realpath(resolve(cwdInput)).catch(() => { throw new PolicyError("مسار التنفيذ غير موجود", 400); });
      if (cwd !== configuredRoot && !cwd.startsWith(`${configuredRoot}${sep}`)) throw new PolicyError("مسار التنفيذ خارج مساحة العمل المسموحة", 403);
      const result = await runCommand(spec, cwd);
      record({ type: "CLI_EXECUTION", intent: "execute_allowlisted_cli", repository: defaultRepo || null, requestedAction: input.tool, tool: input.tool, command: [spec.bin, ...spec.args].join(" "), cwd, result: result.exitCode === 0 && !result.timedOut ? "SUCCESS" : "FAILED", exitCode: result.exitCode, timedOut: result.timedOut, outputTruncated: result.stdoutTruncated || result.stderrTruncated, risk: spec.risk });
      return json(res, 200, { tool: input.tool, ...result, risk: spec.risk });
    }
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    return json(res, 404, { error: "المسار غير موجود" });
  } catch (error) {
    record({ type: "ERROR", result: "FAILED", error: error.message, status: error.status || 500 });
    return json(res, error.status || 500, { error: error.message, status: error.status || 500 });
  }
}

http.createServer(handle).listen(port, () => console.log(`Arabic DevOps MVP listening on http://localhost:${port}`));
