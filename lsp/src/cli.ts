/**
 * Interactive session picker, invoked by the "OpenCode: switch session" Zed task.
 *
 * An LSP can't render a list picker, so this runs in Zed's integrated terminal, lists the
 * OpenCode sessions for the current worktree, and pins the chosen one. The pin is written
 * to the same per-worktree state file the LSP reads, so subsequent sends target it.
 *
 *   bun cli.ts pick <worktreeRoot>
 */
import { createInterface } from "node:readline/promises";
import { basename } from "node:path";
import { stdin, stdout } from "node:process";
import { Store } from "./state.ts";
import { createSession, listSessions, type Session } from "./opencode.ts";

async function pick(worktree: string) {
  const store = new Store();
  const pinned = store.get(worktree).pinnedSessionID;
  const sessions = (await listSessions(worktree)).sort(
    (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
  );

  stdout.write(`\nOpenCode sessions for ${worktree}:\n\n`);
  sessions.forEach((s, i) => {
    const mark = s.id === pinned ? " ← current" : "";
    stdout.write(`  ${String(i + 1).padStart(2)}. ${s.title ?? "(untitled)"}  [${s.id}]${mark}\n`);
  });
  stdout.write(`\n  n. create a new session\n  q. cancel\n\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question("Pin which session? ")).trim().toLowerCase();

  let chosen: Session | undefined;
  if (answer === "q" || answer === "") {
    rl.close();
    stdout.write("Cancelled.\n");
    return;
  } else if (answer === "n") {
    const title = (await rl.question("New session title: ")).trim() || `Zed · ${basename(worktree)}`;
    chosen = await createSession(worktree, title);
  } else {
    const idx = Number(answer) - 1;
    chosen = sessions[idx];
  }
  rl.close();

  if (!chosen) {
    stdout.write("Invalid choice.\n");
    process.exitCode = 1;
    return;
  }
  store.pin(worktree, chosen.id, chosen.title);
  stdout.write(`\n✓ Pinned "${chosen.title ?? chosen.id}". Sends from this worktree now go here.\n`);
}

const [cmd, worktreeArg] = process.argv.slice(2);
// Resolve the worktree without requiring a $ZED_* arg in the task command: an explicit
// arg wins, else Zed's injected env, else the task's cwd (Zed defaults it to the project
// root). Keeping the task command free of $ZED_WORKTREE_ROOT means Zed always shows it,
// instead of hiding it whenever that variable can't resolve in the active context.
const worktree = worktreeArg || process.env.ZED_WORKTREE_ROOT || process.cwd();
if (cmd !== "pick") {
  stdout.write("usage: cli.js pick [worktreeRoot]\n");
  process.exit(1);
}
await pick(worktree);
