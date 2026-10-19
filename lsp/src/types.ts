import type { Range } from "vscode-languageserver";

/** A single code-review annotation captured from a selection in Zed. */
export interface Annotation {
  /** Stable id, embedded in the scratch buffer to correlate edited comments. */
  id: string;
  /** Absolute path of the annotated file. */
  file: string;
  /** Selection range (LSP, 0-based lines/characters). */
  range: Range;
  /** The selected text, used both as the diagnostic fallback and the sent snippet. */
  quote: string;
  /** Language id of the buffer, for fenced code blocks (e.g. "typescript"). */
  language: string;
  /** User-supplied comment (may be empty until typed in the scratch buffer). */
  comment: string;
  created: number;
}

/** Persisted per-worktree state. */
export interface WorktreeState {
  /** The OpenCode session sends currently target. */
  pinnedSessionID?: string;
  /** Human label for the pinned session, for messages/scratch header. */
  pinnedSessionTitle?: string;
  /** The in-progress review draft. */
  annotations: Annotation[];
}
