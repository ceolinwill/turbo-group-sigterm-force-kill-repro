// Starts `turbo run dev` without a terminal in a new session (its own process
// group), waits for the task to be ready, sends one signal, and reports whether
// turbo force-killed the task or let its cleanup finish.
//
//   node repro.mjs            run every case below
//   node repro.mjs <case>     run one case
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = import.meta.dirname;
const app = join(root, "packages/app");
const require = createRequire(import.meta.url);
const arch = process.arch === "x64" ? "64" : process.arch;

const entries = {
  wrapper: join(root, "node_modules/.bin/turbo"),
  native: require.resolve(`@turbo/${process.platform}-${arch}/bin/turbo`),
};

const cases = {
  "wrapper-group-sigterm": {
    title: "npm wrapper, SIGTERM to the process group (kill -TERM -<pgid>)",
    entry: "wrapper",
    target: "group",
    signal: "SIGTERM",
  },
  "wrapper-pid-sigterm": {
    title: "npm wrapper, SIGTERM to the wrapper's PID only (kill -TERM <pid>)",
    entry: "wrapper",
    target: "pid",
    signal: "SIGTERM",
  },
  "native-group-sigterm": {
    title: "native binary, SIGTERM to the process group (kill -TERM -<pgid>)",
    entry: "native",
    target: "group",
    signal: "SIGTERM",
  },
  "wrapper-group-sigint": {
    title: "npm wrapper, SIGINT to the process group (kill -INT -<pgid>)",
    entry: "wrapper",
    target: "group",
    signal: "SIGINT",
  },
  "wrapper-group-sighup": {
    title: "npm wrapper, SIGHUP to the process group (kill -HUP -<pgid>, as when a terminal closes)",
    entry: "wrapper",
    target: "group",
    signal: "SIGHUP",
  },
  "native-group-sighup": {
    title: "native binary, SIGHUP to the process group (kill -HUP -<pgid>)",
    entry: "native",
    target: "group",
    signal: "SIGHUP",
  },
};

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

function readPid(path) {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    return pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runCase(name) {
  const { title, entry, target, signal } = cases[name];
  const ready = join(app, "ready");
  const cleanupDone = join(app, "cleanup-done");
  const logPath = join(root, `${name}.log`);
  rmSync(ready, { force: true });
  rmSync(cleanupDone, { force: true });

  const log = openSync(logPath, "w");
  // detached: true makes the child call setsid(), so it leads a new session and
  // process group whose id is its PID. stdin is /dev/null, so turbo has no TTY.
  const turbo = spawn(entries[entry], ["run", "dev"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", TURBO_NO_UPDATE_NOTIFIER: "1" },
  });
  closeSync(log);
  let exit;
  turbo.on("exit", (code, sig) => (exit = { code, sig, at: Date.now() }));

  let taskPid;
  if (!(await waitFor(() => (taskPid = readPid(ready)), 30_000))) {
    process.kill(-turbo.pid, "SIGKILL");
    throw new Error(`${name}: the task never became ready, see ${logPath}`);
  }
  await sleep(500);

  const sentAt = Date.now();
  process.kill(target === "group" ? -turbo.pid : turbo.pid, signal);
  await waitFor(() => exit, 20_000);
  // Give a task that outlived turbo time to finish on its own.
  await waitFor(() => !isAlive(taskPid), 3_000);

  const output = readFileSync(logPath, "utf8");
  const result = {
    forceKilled: output.includes("Force killed"),
    cleanupDone: existsSync(cleanupDone),
    taskLeftRunning: isAlive(taskPid),
  };

  // Stop anything this case left behind.
  for (const pid of [-turbo.pid, taskPid]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  const graceful = !result.forceKilled && result.cleanupDone && !result.taskLeftRunning;
  const exitText = exit
    ? `code ${exit.code ?? "-"} signal ${exit.sig ?? "-"} after ${((exit.at - sentAt) / 1000).toFixed(1)}s`
    : "still running after 20s";
  const shutdownLines = output
    .split("\n")
    .filter((line) => /Shutting down|Force killed|timed out|dev: (received|cleaning|cleanup)/.test(line));

  console.log(`\n[${name}] ${title}`);
  console.log(`  entry: ${relative(root, entries[entry])}`);
  console.log(`  turbo printed "Force killed": ${result.forceKilled ? "yes" : "no"}`);
  console.log(`  task cleanup finished (cleanup-done written): ${result.cleanupDone ? "yes" : "no"}`);
  console.log(`  task still running afterwards: ${result.taskLeftRunning ? "yes" : "no"}`);
  console.log(`  turbo exited: ${exitText}`);
  console.log(`  shutdown output (full log in ${name}.log):`);
  for (const line of shutdownLines) console.log(`    | ${line}`);
  console.log(`  => ${graceful ? "graceful shutdown" : "BUG: task was not allowed to clean up"}`);
  return graceful;
}

const selected = process.argv[2] ? [process.argv[2]] : Object.keys(cases);
for (const name of selected) {
  if (!cases[name]) {
    console.error(`Unknown case "${name}". Cases: ${Object.keys(cases).join(", ")}`);
    process.exit(2);
  }
}

console.log(`turbo ${JSON.parse(readFileSync(join(root, "node_modules/turbo/package.json"), "utf8")).version}, node ${process.version}, ${process.platform}-${process.arch}`);
let failed = 0;
for (const name of selected) {
  if (!(await runCase(name))) failed++;
}
console.log(`\n${failed === 0 ? "All cases shut down gracefully." : `${failed} case(s) force-killed the task instead of letting it clean up.`}`);
process.exit(failed === 0 ? 0 : 1);
