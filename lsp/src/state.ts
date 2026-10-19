/**
 * Per-worktree persistence of the pinned session + annotation draft.
 *
 * Keyed by worktree root so concurrent projects (and concurrent OpenCode sessions)
 * stay isolated. Persisted under $XDG_STATE_HOME (or ~/.local/state) so a draft and the
 * pinned session survive editor/LSP restarts.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Annotation, WorktreeState } from "./types.ts";

function stateDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const dir = join(base, "zed-opencode");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stateFile(worktree: string): string {
  const hash = createHash("sha256").update(worktree).digest("hex").slice(0, 16);
  return join(stateDir(), `${hash}.json`);
}

/**
 * Read-through / write-through to disk with no in-memory cache. Both the LSP and the
 * picker CLI mutate the same file; reading fresh every time keeps them coherent (the
 * files are tiny, so this is cheap).
 */
export class Store {
  get(worktree: string): WorktreeState {
    try {
      const s = JSON.parse(readFileSync(stateFile(worktree), "utf8")) as WorktreeState;
      if (!Array.isArray(s.annotations)) s.annotations = [];
      return s;
    } catch {
      return { annotations: [] };
    }
  }

  private save(worktree: string, s: WorktreeState): void {
    writeFileSync(stateFile(worktree), JSON.stringify(s, null, 2));
  }

  pin(worktree: string, sessionID: string, title?: string): void {
    const s = this.get(worktree);
    s.pinnedSessionID = sessionID;
    s.pinnedSessionTitle = title;
    this.save(worktree, s);
  }

  addAnnotation(worktree: string, ann: Annotation): void {
    const s = this.get(worktree);
    s.annotations.push(ann);
    this.save(worktree, s);
  }

  /** Replace the comment text of annotations by id (used when parsing the scratch buffer). */
  updateComments(worktree: string, comments: Map<string, string>): boolean {
    const s = this.get(worktree);
    let changed = false;
    for (const ann of s.annotations) {
      const next = comments.get(ann.id);
      if (next !== undefined && next !== ann.comment) {
        ann.comment = next;
        changed = true;
      }
    }
    if (changed) this.save(worktree, s);
    return changed;
  }

  clearAnnotations(worktree: string): void {
    const s = this.get(worktree);
    s.annotations = [];
    this.save(worktree, s);
  }
}
