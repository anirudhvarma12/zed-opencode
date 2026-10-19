//! Thin WASM glue: Zed extensions are headless and can't read selections or draw UI, so
//! all behavior lives in the companion language server under `lsp/` (TypeScript on Bun).
//! This extension's only job is to tell Zed how to launch that server.

use zed_extension_api::{self as zed, Command, LanguageServerId, Result, Worktree};

struct OpencodeCollab;

impl zed::Extension for OpencodeCollab {
    fn new() -> Self {
        OpencodeCollab
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        // Zed does not copy the repo's lsp/ folder into its extension work dir, so we
        // can't point at a bundled file. Instead we run a small launcher placed on PATH
        // by lsp/scripts/install-launcher.sh, located the idiomatic way via `which`.
        let command = worktree.which("opencode-review-lsp").ok_or_else(|| {
            "`opencode-review-lsp` not found on PATH. Run lsp/scripts/install-launcher.sh \
             from the extension repo to install it."
                .to_string()
        })?;

        // Start from the user's shell env (fixes truncated PATH for GUI-launched Zed), and
        // pin the absolute `opencode` path so the LSP's CLI calls work regardless of PATH.
        let mut env = worktree.shell_env();
        if let Some(opencode) = worktree.which("opencode") {
            env.push(("OPENCODE_BIN".to_string(), opencode));
        }

        Ok(Command {
            command,
            args: vec!["--stdio".to_string()],
            env,
        })
    }
}

zed::register_extension!(OpencodeCollab);
