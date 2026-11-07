// A long-running task that needs about 1 second of cleanup when asked to stop.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dirname;
let stopping = false;

function stop(signal) {
  console.log(`dev: received ${signal}`);
  if (stopping) return;
  stopping = true;
  console.log("dev: cleaning up (1s)...");
  setTimeout(() => {
    writeFileSync(join(dir, "cleanup-done"), `${signal}\n`);
    console.log("dev: cleanup done, exiting 0");
    process.exit(0);
  }, 1000);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

writeFileSync(join(dir, "ready"), `${process.pid}\n`);
console.log("dev: ready");
setInterval(() => {}, 1 << 30);
