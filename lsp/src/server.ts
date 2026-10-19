/**
 * OpenCode ↔ Zed companion language server.
 *
 * Zed extensions are headless (no custom UI, can't read selections), but Zed IS a full
 * LSP client. So this server renders the "review UI" through standard LSP surfaces:
 *   - code actions on the current selection  → annotate / send
 *   - diagnostics                            → gutter 📌 + the Project Diagnostics panel
 *   - a scratch buffer (.opencode-review.md) → where the user types comments
 * and forwards everything to OpenCode 2 via the `opencode api` CLI bridge (see opencode.ts).
 */
import {
  CodeAction,
  CodeActionKind,
  createConnection,
  type ExecuteCommandParams,
  type InitializeParams,
  MessageType,
  ProposedFeatures,
  Range,
  ShowMessageNotification,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { readFileSync } from "node:fs";

import { Store } from "./state.ts";
import type { Annotation } from "./types.ts";
import {
  diagnosticsByFile,
  fileRefs,
  refLabel,
  renderReference,
  renderReview,
} from "./annotations.ts";
import { SCRATCH_FILENAME, ensureGitIgnored, parseScratch, renderScratch, scratchPath } from "./scratch.ts";
import { OpencodeError, createSession, listSessions, sendReference, sendReview } from "./opencode.ts";
import { writeFileSync } from "node:fs";

const CMD = {
  sendNow: "opencode.sendNow",
  annotate: "opencode.annotate",
  sendReview: "opencode.sendReview",
  clearReview: "opencode.clearReview",
} as const;

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const store = new Store();

// Diagnostic log to a file we control (Zed's log view only shows server-emitted messages,
// which is confusing). Set OPENCODE_LSP_DEBUG=0 to disable.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
const DEBUG = process.env.OPENCODE_LSP_DEBUG !== "0";
const LOG_FILE = joinPath(
  process.env.XDG_STATE_HOME || joinPath(homedir(), ".local", "state"),
  "zed-opencode",
  "lsp.log",
);
function dbg(msg: string) {
  if (!DEBUG) return;
  try {
    mkdirSync(joinPath(LOG_FILE, ".."), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}
dbg(`=== server process started (pid ${process.pid}) ===`);
process.on("uncaughtException", (e) => dbg(`UNCAUGHT ${e?.stack || e}`));

/** Send a `window/showMessage` toast (notification, no reply expected). */
function toast(type: MessageType, message: string) {
  connection.sendNotification(ShowMessageNotification.type, { type, message });
}

/** Worktree roots from the client, longest-first for prefix matching. */
let workspaceFolders: string[] = [];
/** Files we have published diagnostics for, per worktree, so we can clear them. */
const publishedUris = new Map<string, Set<string>>();

connection.onInitialize((params: InitializeParams) => {
  workspaceFolders = (params.workspaceFolders ?? [])
    .map((f) => fileURLToPath(f.uri))
    .sort((a, b) => b.length - a.length);
  if (workspaceFolders.length === 0 && params.rootUri) {
    workspaceFolders = [fileURLToPath(params.rootUri)];
  }
  dbg(`initialize: folders=${JSON.stringify(workspaceFolders)}`);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Empty] },
      executeCommandProvider: { commands: Object.values(CMD) },
    },
  };
});

connection.onInitialized(() => {
  // Re-publish any annotations persisted from a previous session for all known worktrees.
  for (const wt of workspaceFolders) publishDiagnostics(wt);
});

/** Map a file path to its worktree root (longest matching folder, else its directory). */
function worktreeOf(filePath: string): string {
  for (const folder of workspaceFolders) {
    if (filePath === folder || filePath.startsWith(folder + "/")) return folder;
  }
  return dirname(filePath);
}

function docText(uri: string): { text: string; languageId: string } {
  const doc = documents.get(uri);
  if (doc) return { text: doc.getText(), languageId: doc.languageId };
  return { text: readFileSync(fileURLToPath(uri), "utf8"), languageId: "" };
}

/**
 * Normalize the incoming range:
 * - an empty range (bare cursor, no selection) expands to the whole current line;
 * - a multi-line selection ending at column 0 really ends on the previous line.
 */
function normalizeRange(r: Range, text: string): Range {
  const lines = text.split(/\r?\n/);
  const isEmpty = r.start.line === r.end.line && r.start.character === r.end.character;
  if (isEmpty) {
    const len = lines[r.start.line]?.length ?? 0;
    return { start: { line: r.start.line, character: 0 }, end: { line: r.start.line, character: len } };
  }
  if (r.end.character === 0 && r.end.line > r.start.line) {
    const prev = r.end.line - 1;
    return { start: r.start, end: { line: prev, character: lines[prev]?.length ?? 0 } };
  }
  return r;
}

function buildAnnotation(uri: string, range: Range): Annotation {
  const { text, languageId } = docText(uri);
  const doc = TextDocument.create(uri, languageId, 0, text);
  const norm = normalizeRange(range, text);
  return {
    id: "ann_" + randomUUID().slice(0, 8),
    file: fileURLToPath(uri),
    range: norm,
    quote: doc.getText(norm),
    language: languageId,
    comment: "",
    created: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Code actions: appear in Zed's right-click / quick-action menu on a selection.
// ---------------------------------------------------------------------------
connection.onCodeAction((params) => {
  const uri = params.textDocument.uri;
  const path = fileURLToPath(uri);
  if (basename(path) === SCRATCH_FILENAME) return [];
  const wt = worktreeOf(path);
  const hasSelection =
    params.range.start.line !== params.range.end.line ||
    params.range.start.character !== params.range.end.character;
  const count = store.get(wt).annotations.length;
  dbg(`codeAction: uri=${path} range=${JSON.stringify(params.range)} hasSelection=${hasSelection} annCount=${count}`);

  // Always offer send/annotate (QuickFix is the kind Zed surfaces most reliably). With no
  // selection we fall back to the current line in the command handler, so the actions are
  // available even when the menu is opened on a bare cursor.
  const label = hasSelection ? "selection" : "current line";
  const actions: CodeAction[] = [
    { title: `📤 Send ${label} to OpenCode`, kind: CodeActionKind.QuickFix,
      command: { title: "send", command: CMD.sendNow, arguments: [{ uri, range: params.range }] } },
    { title: `📌 Annotate ${label} for OpenCode review`, kind: CodeActionKind.QuickFix,
      command: { title: "annotate", command: CMD.annotate, arguments: [{ uri, range: params.range }] } },
  ];
  if (count > 0) {
    actions.push(
      { title: `📤 Send review to OpenCode (${count})`, kind: CodeActionKind.QuickFix,
        command: { title: "review", command: CMD.sendReview, arguments: [{ uri }] } },
      { title: "🗑 Clear OpenCode review", kind: CodeActionKind.QuickFix,
        command: { title: "clear", command: CMD.clearReview, arguments: [{ uri }] } },
    );
  }
  return actions;
});

// ---------------------------------------------------------------------------
// Command handlers.
// ---------------------------------------------------------------------------
connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  const arg = (params.arguments?.[0] ?? {}) as { uri?: string; range?: Range };
  if (!arg.uri) return;
  const wt = worktreeOf(fileURLToPath(arg.uri));
  try {
    switch (params.command) {
      case CMD.sendNow:
        return await handleSendNow(wt, arg.uri, arg.range!);
      case CMD.annotate:
        return await handleAnnotate(wt, arg.uri, arg.range!);
      case CMD.sendReview:
        return await handleSendReview(wt);
      case CMD.clearReview:
        return handleClear(wt);
    }
  } catch (err) {
    reportError(err);
  }
});

async function resolvePin(wt: string): Promise<{ id: string; title?: string }> {
  const st = store.get(wt);
  if (st.pinnedSessionID) return { id: st.pinnedSessionID, title: st.pinnedSessionTitle };
  // Auto-pin: reuse the most recent session in this worktree, else create one.
  const existing = await listSessions(wt);
  const session =
    existing.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0] ??
    (await createSession(wt, `Zed · ${basename(wt)}`));
  store.pin(wt, session.id, session.title);
  toast(MessageType.Info,
    `OpenCode: using session "${session.title ?? session.id}". Run the "OpenCode: switch session" task to change it.`,
  );
  return { id: session.id, title: session.title };
}

async function handleSendNow(wt: string, uri: string, range: Range) {
  const ann = buildAnnotation(uri, range);
  const pin = await resolvePin(wt);
  await sendReference(wt, pin.id, {
    text: renderReference(wt, ann),
    files: [{ uri: pathToFileURL(ann.file).toString(), name: basename(ann.file) }],
  });
  toast(MessageType.Info,
    `OpenCode: sent ${refLabel(wt, ann)} → "${pin.title ?? pin.id}".`,
  );
}

async function handleAnnotate(wt: string, uri: string, range: Range) {
  const ann = buildAnnotation(uri, range);
  store.addAnnotation(wt, ann);
  publishDiagnostics(wt);
  await writeScratch(wt);
  toast(MessageType.Info,
    `OpenCode: annotated ${refLabel(wt, ann)}. Add a comment in ${SCRATCH_FILENAME}, then "Send review".`,
  );
}

async function handleSendReview(wt: string) {
  syncCommentsFromScratch(wt); // pick up the latest typed comments
  const st = store.get(wt);
  if (st.annotations.length === 0) {
    toast(MessageType.Warning, "OpenCode: no annotations to send.");
    return;
  }
  const pin = await resolvePin(wt);
  await sendReview(wt, pin.id, {
    text: renderReview(wt, st.annotations),
    files: fileRefs(st.annotations),
  });
  const n = st.annotations.length;
  handleClear(wt);
  toast(MessageType.Info,
    `OpenCode: sent review of ${n} ${n === 1 ? "note" : "notes"} → "${pin.title ?? pin.id}".`,
  );
}

function handleClear(wt: string) {
  store.clearAnnotations(wt);
  publishDiagnostics(wt);
  void writeScratch(wt);
}

// ---------------------------------------------------------------------------
// Diagnostics + scratch sync.
// ---------------------------------------------------------------------------
function publishDiagnostics(wt: string) {
  const byFile = diagnosticsByFile(store.get(wt).annotations);
  const prev = publishedUris.get(wt) ?? new Set<string>();
  const next = new Set<string>();
  for (const [uri, diagnostics] of byFile) {
    connection.sendDiagnostics({ uri, diagnostics });
    next.add(uri);
  }
  for (const uri of prev) {
    if (!next.has(uri)) connection.sendDiagnostics({ uri, diagnostics: [] });
  }
  publishedUris.set(wt, next);
}

async function writeScratch(wt: string) {
  const file = scratchPath(wt);
  ensureGitIgnored(wt); // keep it out of git locally, before the file appears
  writeFileSync(file, renderScratch(wt, store.get(wt)));
  // Best-effort: ask Zed to open the scratch buffer. Ignored if unsupported.
  try {
    await connection.window.showDocument({ uri: pathToFileURL(file).toString(), takeFocus: false });
  } catch {
    /* client may not implement window/showDocument */
  }
}

/** Parse the scratch buffer (open copy if available, else disk) back into the draft. */
function syncCommentsFromScratch(wt: string) {
  const uri = pathToFileURL(scratchPath(wt)).toString();
  const open = documents.get(uri);
  let content: string;
  try {
    content = open ? open.getText() : readFileSync(scratchPath(wt), "utf8");
  } catch {
    return;
  }
  if (store.updateComments(wt, parseScratch(content))) publishDiagnostics(wt);
}

documents.onDidOpen((e) => {
  dbg(`didOpen: uri=${e.document.uri} lang=${e.document.languageId}`);
});

// When the scratch buffer changes in the editor, keep the diagnostics' comments in sync.
documents.onDidChangeContent((e) => {
  const path = fileURLToPath(e.document.uri);
  if (basename(path) !== SCRATCH_FILENAME) return;
  syncCommentsFromScratch(worktreeOf(path));
});

function reportError(err: unknown) {
  if (err instanceof OpencodeError) {
    toast(MessageType.Error, `OpenCode: ${err.message}${err.detail ? ` — ${err.detail}` : ""}`);
  } else {
    toast(MessageType.Error, `OpenCode: ${(err as Error).message ?? String(err)}`);
  }
}

documents.listen(connection);
connection.listen();
