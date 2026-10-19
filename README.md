# OpenCode Collab for Zed

Send code from Zed to [OpenCode 2](https://opencode.ai) sessions — either a single
reference, or a batch of review annotations with comments.

- **Send to OpenCode** — select code → *Send selection to OpenCode*. The file + line
  range + snippet is injected into your pinned session as context, with **no AI reply**.
- **Code review** — *Annotate* several selections across files, type a comment for each in
  a scratch buffer, then *Send review* to deliver them as **one message** that OpenCode
  responds to. (Feature 1 is just this with no comment, sent immediately.)
- **Multiple sessions** — each worktree has its own pinned session; switch with a task.

## How it works (and why it's shaped this way)

Zed extensions are *headless*: they can't read the editor selection or draw custom UI.
They can, however, run a **language server**, and Zed is a full LSP client. So this
extension ships a companion language server that uses standard LSP surfaces as the UI:

| Need | Mechanism |
|------|-----------|
| Read the selection | LSP **code actions** (Zed sends the selection range) |
| Review list | LSP **diagnostics** → gutter 📌 + the **Project Diagnostics** panel |
| Per-annotation comments | a scratch buffer, `.opencode-review.md`, the LSP reads back |
| Pick a session (needs a list UI) | a **Zed task** running an interactive picker |

The language server talks to OpenCode 2 via the **`opencode api`** CLI, which reaches your
running OpenCode background service with auth handled and shares the same session database
as your TUI — so the sessions here are the sessions you already have.

```
Zed ──LSP──> opencode-review (lsp/, Bun/TS) ──`opencode api`──> OpenCode 2 service
```

## Prerequisites

- **OpenCode 2** (`opencode` on PATH). Verify: `opencode service status`.
- **bun** or **node** on PATH (to run the bundled language server).

## Install

```sh
# 1. Build the language server bundle
cd lsp && bun install && bun run build   # -> lsp/dist/server.js, lsp/dist/cli.js

# 2. Install the extension in Zed
#    Zed → Extensions → "Install Dev Extension" → select this repo folder
#    (Zed compiles src/lib.rs to WASM; needs the Rust toolchain / wasm target.)

# 3. Add the task + keybindings
#    - copy zed/tasks.json into your global tasks (`zed: open tasks`) — edit the path
#    - merge zed/keymap.json into your keymap (`zed: open keymap`)
```

## Usage

1. **Pin a session:** run the **OpenCode: switch session** task (`cmd-alt-o`) and pick or
   create a session for this worktree. (If you skip this, the first send auto-pins the
   most recent session, or creates one.)
2. **Send a reference:** select code → code actions (`cmd-alt-.`) → **📤 Send selection to
   OpenCode**.
3. **Build a review:** select code → **📌 Annotate for OpenCode review** (repeat across
   files). Each 📌 shows in the gutter and in **Project Diagnostics**. Open
   `.opencode-review.md` and type a comment under each note.
4. **Send the review:** code actions → **📤 Send review to OpenCode (N)**. Clears the draft.

## Layout

```
extension.toml          Zed manifest; registers the language server across languages
src/lib.rs              WASM glue: launches the bundled LSP (bun/node), pins OPENCODE_BIN
lsp/src/
  server.ts             LSP: code actions, commands, diagnostics, scratch sync
  opencode.ts           bridge to `opencode api` (session.list/create/prompt)
  annotations.ts        annotation → diagnostic + reference/review Markdown
  scratch.ts            .opencode-review.md render + comment parse-back
  state.ts              per-worktree pinned session + draft (under XDG_STATE_HOME)
  cli.ts                interactive session picker (the switch-session task)
zed/tasks.json          the session-picker task
zed/keymap.json         sample keybindings
```

## Keeping the scratch file out of git

The review scratch buffer `.opencode-review.md` is written at the worktree root. The LSP
keeps it out of git **automatically and locally**: on first write it appends the filename
to the repo's `.git/info/exclude` — a repo-local ignore list that is **never committed**,
so it won't touch the tracked `.gitignore` and won't show up for your teammates. This
works for normal repos and for git worktrees/submodules, and is only added once.

Nothing to configure. If you want it ignored in a repo *before* your first annotate, run:

```sh
echo ".opencode-review.md" >> .git/info/exclude
```

(To ignore it in every repo instead, add it to your global excludes:
`git config --global core.excludesfile ~/.gitignore_global` then add the line there.)

## Notes / limits

- The LSP attaches to the broad language set listed in `extension.toml` (plus "Plain
  Text" for unrecognized files); add any missing language there.
- **If the actions don't show in a given language:** check your Zed settings. A
  `languages.<Lang>.language_servers` list *without* `"..."` is treated as the exclusive
  set and will exclude this extension. Add `"..."`, e.g.
  `"TypeScript": { "language_servers": ["vtsls", "..."] }`.
- The picker is a terminal task because LSP/Zed give extensions no list-picker UI.
- Comments are typed in a scratch buffer because LSP/Zed give extensions no text-input
  dialog.
- Discovery/auth are delegated to `opencode api` — no ports or passwords to configure.
- Iterating on the server: `cd lsp && bun run build` then restart the language server.
  Only `extension.toml`/`src/lib.rs` changes require rebuilding the extension in Zed.
