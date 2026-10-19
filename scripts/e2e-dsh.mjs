#!/usr/bin/env node
// 真实 dsh 端到端验证：在临时目录装指定版本的 dsh 与本仓库 dsh 插件，用本地 OpenAI 兼容假模型注入故障，
// 经 sdk profile（JSON-RPC）跑续跑场景；设置 DIDA_E2E_PROJECT_ID 时再跑滴答同步/收口/转人工场景。
//
//   node scripts/e2e-dsh.mjs                               # 默认 dsh@next，插件用当前工作区打包
//   DSH_VERSION=0.2.1-rc.2 node scripts/e2e-dsh.mjs
//   DIDA_E2E_PROJECT_ID=<一次性专用清单> node scripts/e2e-dsh.mjs   # 会在该清单建任务，跑完请删除清单
//
// 不碰用户的 ~/.dsh 与 ~/.config/pi-dida-todo：DSH_HOME 与 HOME 都指向临时目录（只软链 dida CLI 登录态）。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const dshVersion = process.env.DSH_VERSION ?? "next";
const didaProject = process.env.DIDA_E2E_PROJECT_ID;
const keep = process.env.E2E_KEEP === "1";
const root = mkdtempSync(join(tmpdir(), "dida-dsh-e2e-"));
const dshHome = join(root, "dsh-home");
const fakeHome = join(root, "home");
const dsh = join(root, "node_modules", ".bin", "dsh");
const results = [];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
const log = (msg) => console.log(`[e2e] ${msg}`);

// ---------- 假模型：脚本逐请求消费，最后一项重复 ----------
let script = ["ok"];
let served = 0;
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
    }
    const step = script[Math.min(served, script.length - 1)];
    served += 1;
    if (step === "hang") return; // 不应答：模拟宿主重启打断的回合
    res.writeHead(200, { "content-type": "text/event-stream" });
    const id = `chatcmpl-${served}`;
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const toolCall = (name, args) => {
      res.write(chunk({ tool_calls: [{ index: 0, id: `call_${served}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }));
      res.write(chunk({}, "tool_calls"));
    };
    res.write(chunk({ role: "assistant", content: "" }));
    if (step === "todo_write") toolCall("todo_write", { todos: [{ content: "e2e step one", status: "in_progress" }, { content: "e2e step two", status: "pending" }] });
    else if (step === "dida_create") toolCall("todo", { action: "create", workTitle: "dsh e2e 验证", subject: "第一步", items: ["第二步"] });
    else if (step.startsWith("dida_done_")) toolCall("todo", { action: "update", id: Number(step.slice(10)), status: "completed", metadata: { resolution: "e2e ok" } });
    else if (step === "filter") { res.write(chunk({ content: "partial" })); res.write(chunk({}, "content_filter")); }
    else { res.write(chunk({ content: `mock reply #${served}` })); res.write(chunk({}, "stop")); }
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "mock-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});

// ---------- 一次 sdk 会话：发 prompt（或 resume），收集 turn/end、续跑消息、todo/write、插件日志 ----------
function session({ cwd, prompt = "go", resume = false, sessionId = `e2e-${Date.now()}`, wantTurns, timeoutMs = 45000, lingerMs = 1500 }) {
  mkdirSync(cwd, { recursive: true });
  return new Promise((done) => {
    const child = spawn(dsh, ["--profile", "sdk"], { cwd, env: { ...process.env, DSH_HOME: dshHome, HOME: fakeHome, MOCK_API_KEY: "x" }, stdio: ["pipe", "pipe", "pipe"] });
    const out = { turns: [], continues: 0, todoWrites: [], logs: [] };
    const pending = new Map();
    let buf = "";
    let nextId = 1;
    child.stderr.on("data", (d) => { for (const l of String(d).split("\n")) if (l.includes("[dida-todo]")) out.logs.push(l.trim()); });
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); continue; }
        const ev = msg.method === "session.event" ? msg.params.event : undefined;
        if (ev?.type === "turn/end") out.turns.push(ev.data.reason.kind);
        if (ev?.type === "todo/write") out.todoWrites.push(ev.data.todos);
        if (ev?.type === "user/message" && ev.data.source?.kind === "dida-todo") out.continues += 1;
      }
    });
    const call = (method, params) => new Promise((ok, fail) => {
      const id = nextId++;
      pending.set(id, (m) => (m.error ? fail(new Error(JSON.stringify(m.error))) : ok(m.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    (async () => {
      const deadline = Date.now() + timeoutMs;
      try {
        await call("initialize", { cwd, provider: "mock", model: "mock-model" });
        if (resume) await call("session/resume", { sessionId });
        else await call("session/prompt", { sessionId, contentBlocks: [{ type: "text", text: prompt }] });
        while (Date.now() < deadline && out.turns.length < wantTurns) await new Promise((r) => setTimeout(r, 300));
        await new Promise((r) => setTimeout(r, lingerMs));
      } catch (error) {
        out.error = error.message;
      }
      child.kill("SIGTERM");
      setTimeout(() => done(out), 300);
    })();
  });
}

function check(name, ok, detail) {
  results.push({ name, ok });
  log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function dida(args) {
  return JSON.parse(run(join(repo, "node_modules", ".bin", "dida"), [...args, "--json"]));
}

try {
  // ---------- 环境 ----------
  log(`root ${root}`);
  log(`安装 @deepseek-ai/dsh@${dshVersion} …`);
  run("npm", ["init", "-y"], { cwd: root });
  run("npm", ["i", "--no-audit", "--no-fund", `@deepseek-ai/dsh@${dshVersion}`], { cwd: root });
  const installed = JSON.parse(run("node", ["-p", "JSON.stringify(require('@deepseek-ai/dsh/package.json').version)"], { cwd: root }));
  log(`dsh ${installed}`);

  log("打包本仓库插件 …");
  run("npm", ["run", "-s", "build:dsh"], { cwd: repo });
  const tgz = run("npm", ["pack", "--pack-destination", root], { cwd: repo }).trim().split("\n").pop();

  mkdirSync(join(fakeHome, ".config", "pi-dida-todo"), { recursive: true });
  const didaAuth = join(homedir(), ".config", "dida-cli");
  if (existsSync(didaAuth)) symlinkSync(didaAuth, join(fakeHome, ".config", "dida-cli"));
  const boundCwd = join(root, "ws-bound");
  writeFileSync(join(fakeHome, ".config", "pi-dida-todo", "config.json"), JSON.stringify({
    bindings: didaProject ? [{ key: `cwd:${boundCwd}`, cwd: boundCwd, projectId: didaProject, label: "e2e" }] : [],
  }), { mode: 0o600 });

  const env = { ...process.env, DSH_HOME: dshHome };
  run(dsh, ["plugin", "--profile", "sdk", "list"], { env });
  writeFileSync(join(dshHome, "profiles", "sdk", ".npmrc"), "ignore-workspace-root-check=true\n");
  run(dsh, ["plugin", "--profile", "sdk", "add", join(root, tgz)], { env });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  writeFileSync(join(dshHome, "profiles", "sdk", "cordis.patch.yml"), `- id: llm-pi-ai
  config:
    providers:
      mock:
        apiKeyEnv: MOCK_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${mock.address().port}/v1
        models:
          - id: mock-model
- id: dida-todo
  config:
    maxAutoContinue: 3
    continueDelayMs: 1500
    poll: false
`);
  const dump = run(dsh, ["--profile", "sdk", "--dump-config"], { env });
  check("插件挂载且 dsh 自带 todo_write 保留", /- id: dida-todo\n/.test(dump) && /- id: tool-todo\n/.test(dump));

  // ---------- 续跑场景（不需要滴答） ----------
  script = ["todo_write", "filter", "ok"]; served = 0;
  let r = await session({ cwd: join(root, "ws-a"), wantTurns: 2 });
  check("有未完成 todo_write 时 content_filter 中断 → 自动续跑后完成", r.turns.join() === "error,completed" && r.continues === 1, r);

  script = ["filter", "ok"]; served = 0;
  r = await session({ cwd: join(root, "ws-b"), wantTurns: 2, timeoutMs: 8000 });
  check("没有未完成工作 → 不续跑", r.turns.join() === "error" && r.continues === 0, r);

  script = ["todo_write", "filter"]; served = 0;
  r = await session({ cwd: join(root, "ws-c"), wantTurns: 4, timeoutMs: 30000 });
  check("持续失败 → 续跑 3 次后停止并转人工", r.turns.length === 4 && r.continues === 3 && r.logs.some((l) => l.includes("转为滴答提醒")), r);

  script = ["todo_write", "hang"]; served = 0;
  await session({ cwd: join(root, "ws-d"), sessionId: "e2e-restart", wantTurns: 9, timeoutMs: 6000, lingerMs: 0 });
  script = ["ok"]; served = 0;
  r = await session({ cwd: join(root, "ws-d"), sessionId: "e2e-restart", resume: true, wantTurns: 1 });
  check("宿主重启打断的回合 → 恢复会话后自动续跑", r.turns.join() === "completed" && r.continues === 1 && r.logs.some((l) => l.includes("恢复时发现上一回合中断")), r);

  // ---------- 滴答场景（需一次性专用清单） ----------
  if (didaProject) {
    script = ["dida_create", "dida_done_1", "dida_done_2", "ok"]; served = 0;
    r = await session({ cwd: boundCwd, wantTurns: 1, lingerMs: 20000 });
    const last = r.todoWrites.at(-1) ?? [];
    check("todo 建滴答工作 → 镜像到 dsh 任务面板", last.length === 2 && last.every((t) => t.status === "completed"), r);
    const open = dida(["project", "data", didaProject]).tasks.map((t) => t.title);
    check("全部子项完成 → 顶层自动完成并生成待验收", !open.includes("dsh e2e 验证") && open.some((t) => t.startsWith("🧑‍🔬 待验收：dsh e2e 验证")), open);

    script = ["todo_write", "filter"]; served = 0;
    await session({ cwd: boundCwd, wantTurns: 4, timeoutMs: 30000 });
    const after = dida(["project", "data", didaProject]).tasks.map((t) => t.title);
    check("续跑用尽 → 滴答出现 🙋 提醒", after.some((t) => t.startsWith("🙋 需要你处理")), after);
  } else {
    log("跳过滴答场景（未设置 DIDA_E2E_PROJECT_ID）");
  }
} catch (error) {
  check("环境准备", false, String(error?.stderr || error?.message || error).slice(0, 800));
} finally {
  mock.close();
  if (keep) log(`保留现场 ${root}`);
  else rmSync(root, { recursive: true, force: true });
  for (const f of readdirSync(repo)) if (/^dida-todo-.*\.tgz$/.test(f)) rmSync(join(repo, f));
}

const failed = results.filter((r) => !r.ok).length;
log(`${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
