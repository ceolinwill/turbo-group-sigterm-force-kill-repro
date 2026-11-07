# turbo: a group-directed SIGTERM or SIGHUP force-kills tasks through the npm wrapper

When `turbo run` is started through its npm package (`node_modules/.bin/turbo`, `npx turbo`, or an npm script) and a SIGTERM is sent to its process group (`kill -TERM -<pgid>`, Python's `os.killpg`, and process managers, CI runners and agent harnesses that stop a whole job), turbo prints `Force killed Turborepo tasks: …` and SIGKILLs its tasks within milliseconds, so their cleanup never runs. The same signal sent to the native binary's group, or to the wrapper's PID only, shuts down gracefully, and so does SIGINT to the group. On `2.11.11-canary.2` a group-directed SIGHUP, which is what bash sends its foreground job when the terminal closes, does the same, while `2.11.10` shut down gracefully.

Issue: _link added after filing_

## Reproduction

```sh
npm install
npm run repro
```

`repro.mjs` starts `turbo run dev` with stdin from `/dev/null` in a new session (`spawn` with `detached: true`, so turbo leads its own process group), waits until the task in `packages/app/dev.mjs` writes `ready`, sends one signal, and checks turbo's output and the `cleanup-done` file the task writes after one second of cleanup. It runs each case below and exits 1 if any case force-kills the task. `node repro.mjs <case>` runs one case.

Output on macOS:

```text
> repro
> node repro.mjs

turbo 2.11.11-canary.2, node v24.22.0, darwin-arm64

[wrapper-group-sigterm] npm wrapper, SIGTERM to the process group (kill -TERM -<pgid>)
  entry: node_modules/.bin/turbo
  turbo printed "Force killed": yes
  task cleanup finished (cleanup-done written): no
  task still running afterwards: no
  turbo exited: code 0 signal - after 0.1s
  shutdown output (full log in wrapper-group-sigterm.log):
    | Shutting down Turborepo tasks...
    | Force killed Turborepo tasks: app#dev
  => BUG: task was not allowed to clean up

[wrapper-pid-sigterm] npm wrapper, SIGTERM to the wrapper's PID only (kill -TERM <pid>)
  entry: node_modules/.bin/turbo
  turbo printed "Force killed": no
  task cleanup finished (cleanup-done written): yes
  task still running afterwards: no
  turbo exited: code 0 signal - after 1.1s
  shutdown output (full log in wrapper-pid-sigterm.log):
    | Shutting down Turborepo tasks...
    | app:dev: dev: received SIGINT
    | app:dev: dev: cleaning up (1s)...
    | app:dev: dev: received SIGINT
    | app:dev: dev: cleanup done, exiting 0
  => graceful shutdown

[native-group-sigterm] native binary, SIGTERM to the process group (kill -TERM -<pgid>)
  entry: node_modules/@turbo/darwin-arm64/bin/turbo
  turbo printed "Force killed": no
  task cleanup finished (cleanup-done written): yes
  task still running afterwards: no
  turbo exited: code 0 signal - after 1.1s
  shutdown output (full log in native-group-sigterm.log):
    | Shutting down Turborepo tasks...
    | app:dev: dev: received SIGINT
    | app:dev: dev: cleaning up (1s)...
    | app:dev: dev: received SIGINT
    | app:dev: dev: cleanup done, exiting 0
  => graceful shutdown

[wrapper-group-sigint] npm wrapper, SIGINT to the process group (kill -INT -<pgid>)
  entry: node_modules/.bin/turbo
  turbo printed "Force killed": no
  task cleanup finished (cleanup-done written): yes
  task still running afterwards: no
  turbo exited: code 0 signal - after 1.0s
  shutdown output (full log in wrapper-group-sigint.log):
    | Shutting down Turborepo tasks...
    | app:dev: dev: received SIGINT
    | app:dev: dev: cleaning up (1s)...
    | app:dev: dev: received SIGINT
    | app:dev: dev: cleanup done, exiting 0
  => graceful shutdown

[wrapper-group-sighup] npm wrapper, SIGHUP to the process group (kill -HUP -<pgid>, as when a terminal closes)
  entry: node_modules/.bin/turbo
  turbo printed "Force killed": yes
  task cleanup finished (cleanup-done written): no
  task still running afterwards: no
  turbo exited: code 0 signal - after 0.0s
  shutdown output (full log in wrapper-group-sighup.log):
    | Shutting down Turborepo tasks...
    | Force killed Turborepo tasks: app#dev
  => BUG: task was not allowed to clean up

[native-group-sighup] native binary, SIGHUP to the process group (kill -HUP -<pgid>)
  entry: node_modules/@turbo/darwin-arm64/bin/turbo
  turbo printed "Force killed": no
  task cleanup finished (cleanup-done written): yes
  task still running afterwards: no
  turbo exited: code 0 signal - after 1.0s
  shutdown output (full log in native-group-sighup.log):
    | Shutting down Turborepo tasks...
    | app:dev: dev: received SIGINT
    | app:dev: dev: cleaning up (1s)...
    | app:dev: dev: received SIGINT
    | app:dev: dev: cleanup done, exiting 0
  => graceful shutdown

2 case(s) force-killed the task instead of letting it clean up.
```

In the graceful cases the task logs SIGINT twice because `npm run` also forwards turbo's SIGINT to its script. The task ignores the repeat; that's unrelated to this bug.

### Closing a real terminal (optional)

`terminal-close.py` runs `turbo run dev` as the foreground job of an interactive shell on a pseudo-terminal (Python standard library only), then closes the terminal:

```sh
python3 terminal-close.py bash wrapper   # 2.11.11-canary.2: Force killed, no cleanup (2.11.10: graceful)
python3 terminal-close.py bash native    # graceful
```

```text
bash, node_modules/.bin/turbo, terminal closed
  turbo printed "Force killed": yes
  task cleanup finished (cleanup-done written): no
    |  - Shutting down Turborepo tasks...Press CTRL+C again to exit forcefully.
    |  - Force killed Turborepo tasks: app#dev
bash, node_modules/@turbo/darwin-arm64/bin/turbo, terminal closed
  turbo printed "Force killed": no
  task cleanup finished (cleanup-done written): yes
    |  - Shutting down Turborepo tasks...Press CTRL+C again to exit forcefully.
    | app:dev: dev: received SIGINT
    | app:dev: dev: cleaning up (1s)...
    | app:dev: dev: received SIGINT
    | app:dev: dev: cleanup done, exiting 0
```

zsh 5.9 sends its foreground job SIGHUP twice when the terminal closes, so with zsh even the native binary force-kills, on both versions. That's a separate effect; use bash to see the wrapper's part.

## Expected

A signal sent to turbo's process group is one stop request. Every case shuts down like `native-group-sigterm`: turbo stops the task once, waits for it, the task writes `cleanup-done`, and turbo never prints `Force killed`.

## Actual

Through the npm wrapper, a group-directed SIGTERM (and, on the canary, SIGHUP) force-kills the task within about 0.1 s, before it handles its first signal.

The wrapper [spawns the native binary](https://github.com/vercel/turborepo/blob/v2.11.11-canary.2/packages/turbo/bin/turbo#L486-L493) without `detached`, so both share the process group that receives the signal:

```text
  PID  PPID  PGID COMMAND
65482     1 65482 node node_modules/.bin/turbo run dev
65486 65482 65482 node_modules/@turbo/darwin-arm64/bin/turbo run dev
```

1. The group signal reaches native turbo directly, and it starts a graceful shutdown.
2. The same signal reaches the wrapper, whose handler forwards it to native turbo ([`handleSigterm`](https://github.com/vercel/turborepo/blob/v2.11.11-canary.2/packages/turbo/bin/turbo#L534-L538), and on the canary [`handleSighup`](https://github.com/vercel/turborepo/blob/v2.11.11-canary.2/packages/turbo/bin/turbo#L540-L544) from [#14856](https://github.com/vercel/turborepo/pull/14856)).
3. Native turbo counts every OS signal received during shutdown ([`turborepo-signals/src/lib.rs`](https://github.com/vercel/turborepo/blob/v2.11.11-canary.2/crates/turborepo-signals/src/lib.rs#L128-L132)) and treats a count above one as "exit forcefully" ([`wait_for_forced_shutdown`](https://github.com/vercel/turborepo/blob/v2.11.11-canary.2/crates/turborepo-run/src/lib.rs#L358-L376)), so it prints `Force killed Turborepo tasks` and calls `kill_all` ([lib.rs#L444-L447](https://github.com/vercel/turborepo/blob/v2.11.11-canary.2/crates/turborepo-run/src/lib.rs#L444-L447)).

SIGINT to the group is fine because on Unix the wrapper's SIGINT handler doesn't forward anything (it only writes to the Windows Ctrl+C pipe). On `2.11.10` a group SIGHUP is fine because that wrapper has no SIGHUP handler: Node exits on it and native turbo gets the signal once.

## Environment

- turbo `2.11.11-canary.2` (latest canary on 2026-11-07); the SIGTERM case also reproduces on `2.11.10` (latest stable) in 3 of 3 runs
- npm 11.19.1, Node.js 24.22.0
- macOS 27.2 (arm64), bash 3.2.57 and zsh 5.9 for `terminal-close.py`
- Linux: the [repro workflow](.github/workflows/repro.yml) runs `npm run repro` on `ubuntu-latest` and `macos-latest`
