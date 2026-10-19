/**
 * The review scratch buffer (`.opencode-review.md` at the worktree root) is the one place
 * the user types free-text comments — LSP/Zed give extensions no text-input dialog. The
 * LSP renders annotations into it and parses edited comments back out. Each block carries
 * a hidden `<!-- oc:ID -->` marker so comments stay correlated to annotations across edits.
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Annotation, WorktreeState } from "./types.ts";
import { refLabel } from "./annotations.ts";

export const SCRATCH_FILENAME = ".opencode-review.md";

export function scratchPath(worktree: string): string {
  return join(worktree, SCRATCH_FILENAME);
}

/**
 * Keep the scratch file out of git locally, without touching the tracked .gitignore.
 * `.git/info/exclude` is a repo-local, uncommitted ignore list — perfect for a personal
 * tool. Best-effort: silently no-ops if this isn't a git repo.
 */
export function ensureGitIgnored(worktree: string): void {
  try {
    const dotgit = join(worktree, ".git");
    if (!existsSync(dotgit)) return;
    // `.git` is a dir in normal repos, or a file ("gitdir: <path>") in worktrees/submodules.
    let gitDir = dotgit;
    if (statSync(dotgit).isFile()) {
      const m = /gitdir:\s*(.+)/.exec(readFileSync(dotgit, "utf8"));
      if (!m) return;
      gitDir = join(worktree, m[1]!.trim());
    }
    const infoDir = join(gitDir, "info");
    const excludeFile = join(infoDir, "exclude");
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (existing.split(/\r?\n/).includes(SCRATCH_FILENAME)) return;
    mkdirSync(infoDir, { recursive: true });
    appendFileSync(excludeFile, `${existing && !existing.endsWith("\n") ? "\n" : ""}${SCRATCH_FILENAME}\n`);
  } catch {
    /* best-effort */
  }
}

const MARKER = /^<!--\s*oc:(\S+)\s*-->$/;
const COMMENT_PLACEHOLDER = "_Type your review comment here…_";

/** Render the whole draft to Markdown for the scratch buffer. */
export function renderScratch(worktree: string, state: WorktreeState): string {
  const { annotations } = state;
  const target = state.pinnedSessionTitle || state.pinnedSessionID || "(no session pinned)";
  const out: string[] = [
    "# OpenCode review draft",
    "",
    `> Target session: **${target}** · ${annotations.length} ${annotations.length === 1 ? "note" : "notes"}`,
    "> Edit the comments under each note, then run **OpenCode: Send review**.",
    "",
  ];
  if (annotations.length === 0) {
    out.push("_No annotations yet. Select code and run **OpenCode: Annotate**._");
  }
  for (const ann of annotations) {
    out.push(`## \`${refLabel(worktree, ann)}\``);
    out.push(`<!-- oc:${ann.id} -->`);
    out.push(ann.comment.trim() || COMMENT_PLACEHOLDER);
    out.push("");
    out.push("```" + (ann.language || ""));
    out.push(ann.quote.replace(/```/g, "ˋˋˋ"));
    out.push("```");
    out.push("");
  }
  return out.join("\n");
}

/**
 * Parse edited comments back out: for each `<!-- oc:ID -->` marker, the comment is the
 * text between it and the following code fence (or next heading / next marker), minus the
 * placeholder.
 */
export function parseScratch(content: string): Map<string, string> {
  const lines = content.split(/\r?\n/);
  const comments = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(MARKER);
    if (!m) continue;
    const id = m[1]!;
    const buf: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.startsWith("```") || line.startsWith("## ") || MARKER.test(line)) break;
      buf.push(line);
    }
    let text = buf.join("\n").trim();
    if (text === COMMENT_PLACEHOLDER) text = "";
    comments.set(id, text);
  }
  return comments;
}
