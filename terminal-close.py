# Runs `turbo run dev` as the foreground job of an interactive shell on a
# pseudo-terminal, closes the terminal, and reports whether the task's cleanup ran.
#
#   python3 terminal-close.py [bash|zsh] [wrapper|native]
import os, platform, pty, select, sys, time

shell = sys.argv[1] if len(sys.argv) > 1 else "bash"
entry = sys.argv[2] if len(sys.argv) > 2 else "wrapper"
root = os.path.dirname(os.path.abspath(__file__))
app = os.path.join(root, "packages/app")
arch = {"x86_64": "64", "aarch64": "arm64"}.get(platform.machine(), platform.machine())
turbo = {
    "wrapper": "node_modules/.bin/turbo",
    "native": f"node_modules/@turbo/{sys.platform.rstrip('0123456789')}-{arch}/bin/turbo",
}[entry]
log = os.path.join(root, "terminal-close.log")
for name in ("ready", "cleanup-done"):
    if os.path.exists(os.path.join(app, name)):
        os.remove(os.path.join(app, name))

pid, fd = pty.fork()
if pid == 0:
    os.chdir(root)
    os.environ.update(TURBO_TELEMETRY_DISABLED="1", TURBO_NO_UPDATE_NOTIFIER="1")
    args = ["-f", "-i"] if shell == "zsh" else ["--norc", "--noprofile", "-i"]
    os.execvp(shell, [shell, *args])


def drain(seconds):
    end = time.time() + seconds
    while time.time() < end:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                os.read(fd, 65536)
            except OSError:
                return


def task_pid():
    try:
        return int(open(os.path.join(app, "ready")).read())
    except (FileNotFoundError, ValueError):
        return None


drain(1)
os.write(fd, f"{turbo} run dev --ui=stream > terminal-close.log 2>&1\n".encode())
end = time.time() + 30
while time.time() < end and not task_pid():
    drain(0.1)
pid_of_task = task_pid()
drain(0.5)
os.close(fd)  # close the terminal
time.sleep(4)

output = open(log).read()
try:
    os.kill(pid_of_task, 0)
    alive = True
except ProcessLookupError:
    alive = False
print(f"{shell}, {turbo}, terminal closed")
print(f"  turbo printed \"Force killed\": {'yes' if 'Force killed' in output else 'no'}")
print(f"  task cleanup finished (cleanup-done written): {'yes' if os.path.exists(os.path.join(app, 'cleanup-done')) else 'no'}")
for line in output.splitlines():
    if any(key in line for key in ("Shutting down", "Force killed", "dev: received", "dev: clean")):
        print(f"    | {line}")
if alive:
    os.kill(pid_of_task, 9)
