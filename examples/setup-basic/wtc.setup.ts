import { defineSetup } from "@lyonbot/wtc/setup";

/** Minimal example setup: a tiny node server in /workspace/app, used by the integration tests. */
export default defineSetup({
  id: "basic",
  params: {
    APP_GREETING: { description: "greeting the dev server responds with", default: "hello" },
    FAIL_AT: { description: "test hook: 'install' makes init exit 3, 'hang' makes init sleep forever", default: "" },
  },
  cwd: "/workspace/app",
  scripts: {
    "restart-dev-server": { run: "/wtc/setup/scripts/restart-dev-server.sh", description: "restart the dev server (tmux session 'dev')" },
  },
  checks: {
    http: { run: "curl -fsS http://127.0.0.1:5173/health" },
  },
  container: {
    hostForwards: [16379],
    mounts: [{ type: "volume", name: "scratch", target: "/scratch", scope: "instance" }],
  },
  preRemove: "test ! -f /workspace/app/.keep",
});
