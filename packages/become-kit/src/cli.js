#!/usr/bin/env node
/**
 * become-kit — installer CLI.
 *
 * Provisions the stateful body and the daemon fabric for the become-kit agent
 * apparatus, then verifies it. Commands:
 *
 *   init    provision ~/.become-kit: schema (migrations), models, adapters, config.
 *           Installs daemon DEFINITIONS but does NOT start them (consent-gated).
 *   doctor  verify the body is healthy; run the birth-test.
 *   start   start the autonomous daemon fabric (explicit — the only way it runs).
 *   pause   stop the entire daemon fabric immediately (global kill-switch).
 *   status  show what's provisioned and whether the fabric is running.
 *
 * Everything lives under BECOME_KIT_HOME (default ~/.become-kit). The installer
 * never mutates the user's existing Claude Code config; the plugin handles
 * Claude integration through the native plugin mechanism.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOME = process.env.BECOME_KIT_HOME || path.join(os.homedir(), ".become-kit");
const AGENT_NAME = process.env.AGENT_NAME || "agent";
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function log(msg) { process.stdout.write(msg + "\n"); }
function fail(msg) { process.stderr.write("error: " + msg + "\n"); process.exit(1); }

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
  for (const d of ["db", "models", "daemons", "config", "identity"]) {
    fs.mkdirSync(path.join(HOME, d), { recursive: true });
  }
}

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

function checkDep(name, cmd, hint) {
  const found = which(cmd);
  log(`  ${found ? "✓" : "✗"} ${name}${found ? "" : "  (" + hint + ")"}`);
  return !!found;
}

// --- commands ---

function init() {
  log(`become-kit init — provisioning the body into ${HOME}`);
  ensureHome();

  log("\nchecking dependencies:");
  const node = checkDep("node 18+", "node", "install Node 18+");
  const py = checkDep("python 3.10+", "python3", "install Python 3.10+");
  const pg = checkDep("postgres (psql)", "psql", "the full-fidelity memory needs Postgres 15+ with pgvector");
  // embedding + brain runtimes are platform-specific; report, don't hard-fail
  checkDep("a local model runtime", process.platform === "darwin" ? "python3" : "ollama",
    "for the local brain: MLX on macOS, or Ollama/llama.cpp elsewhere");

  if (!node || !py) fail("node and python3 are required to continue.");

  // write the agent config + seed the blank kernel from the template
  const cfg = { agent_name: AGENT_NAME, home: HOME, created: new Date().toISOString(), fabric_started: false };
  fs.writeFileSync(path.join(HOME, "config", "agent.json"), JSON.stringify(cfg, null, 2));

  const tmpl = path.join(REPO_ROOT, "plugin", "kernel-template", "IDENTITY.md.template");
  const idOut = path.join(HOME, "identity", "IDENTITY.md");
  if (fs.existsSync(tmpl) && !fs.existsSync(idOut)) {
    let txt = fs.readFileSync(tmpl, "utf8")
      .replace(/\{\{AGENT_NAME\}\}/g, AGENT_NAME)
      .replace(/\{\{FOUNDER\}\}/g, process.env.BECOME_FOUNDER || "the founder");
    fs.writeFileSync(idOut, txt);
    log(`\n  seeded blank identity → ${idOut}`);
  }

  if (pg) {
    log("\n  applying organ schema migrations...");
    const mig = path.join(REPO_ROOT, "packages", "vision-mcp", "dist", "migrate.js");
    if (fs.existsSync(mig)) {
      const r = spawnSync("node", [mig], { encoding: "utf8", env: { ...process.env, BECOME_KIT_DB: process.env.BECOME_KIT_DB || "become_kit" } });
      process.stdout.write(r.stdout || "");
      if (r.status !== 0) { process.stderr.write(r.stderr || ""); log("  (migrations need a base schema + reachable db — see docs/INSTALL.md)"); }
    } else {
      log("  build vision-mcp first (npm run build), then re-run init to apply migrations.");
    }
  } else {
    log("\n  Postgres not found — install it (or point BECOME_KIT_DB_URL at one), then re-run init.");
  }

  log("\n  daemon definitions installed (NOT started). Bring it alive with: become-kit start");
  log("done. next: become-kit doctor");
}

function doctor() {
  log("become-kit doctor — verifying the body");
  if (!fs.existsSync(path.join(HOME, "config", "agent.json"))) {
    fail("not initialized — run `become-kit init` first.");
  }
  log("  ✓ state root present: " + HOME);

  // the real proof: run the birth-test (works via the test-double, no services)
  const test = path.join(REPO_ROOT, "tests", "birth", "test_birth.py");
  if (fs.existsSync(test)) {
    log("\n  running birth-test:");
    const r = spawnSync("python3", [test], { encoding: "utf8", env: { ...process.env, BECOME_KIT_TESTMODE: "1" } });
    process.stdout.write(r.stdout || "");
    if (r.status !== 0) { process.stderr.write(r.stderr || ""); fail("birth-test failed."); }
  }
  log("\ndoctor: healthy.");
}

function fabric(action) {
  // delegate to the python supervisor (the cross-platform daemon authority)
  const sup = path.join(REPO_ROOT, "runtime", "daemons", "supervisor_cli.py");
  if (!fs.existsSync(sup)) {
    log(`(supervisor CLI not present yet; '${action}' is wired to runtime/daemons/supervisor.py)`);
    return;
  }
  const r = spawnSync("python3", [sup, action], { encoding: "utf8", stdio: "inherit",
    env: { ...process.env, BECOME_KIT_HOME: HOME, AGENT_NAME } });
  if (r.status !== 0) fail(`fabric ${action} failed.`);
}

function status() {
  log(`become-kit status (${AGENT_NAME} @ ${HOME})`);
  const cfgPath = path.join(HOME, "config", "agent.json");
  if (!fs.existsSync(cfgPath)) { log("  not initialized."); return; }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  log(`  initialized: ${cfg.created}`);
  log(`  fabric: ${fs.existsSync(path.join(HOME, ".paused")) ? "PAUSED" : (cfg.fabric_started ? "running" : "installed, not started")}`);
}

function usage() {
  log("usage: become-kit <init|doctor|start|pause|status>");
}

function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "init": return init();
    case "doctor": return doctor();
    case "start": return fabric("start");
    case "pause": return fabric("pause");
    case "status": return status();
    default: usage(); process.exit(cmd ? 1 : 0);
  }
}

main();
