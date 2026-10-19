/**
 * Thin bridge to the OpenCode 2 background service via the `opencode api` CLI.
 *
 * Why the CLI and not @opencode-ai/sdk / raw HTTP: the v2 background service picks a
 * random port + password, and `opencode api <operationId>` already knows how to reach
 * it with auth handled. It also shares the same SQLite DB as the user's TUI, so the
 * sessions we see and write are exactly the sessions the user sees. Operation IDs
 * (session.list / session.create / session.prompt) are stable across versions, whereas
 * the SDK 1.19.3 routes/bodies do not match server 2.0.32.
 */
import { execFile } from "node:child_process";

const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

export interface Session {
  id: string;
  title?: string;
  projectID?: string;
  parentID?: string;
  location?: { directory?: string };
  time?: { created?: number; updated?: number };
}

/** A file region to send as a reference. `uri` is a `file://` URL. */
export interface FileRef {
  uri: string;
  name?: string;
}

export interface PromptBody {
  text: string;
  files?: FileRef[];
  /** false = inject into the session inbox with no model turn; true = run + reply. */
  resume: boolean;
}

export class OpencodeError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "OpencodeError";
  }
}

/** Run `opencode api <args...>`, optionally piping a JSON body on stdin via `-d`. */
function ocApi(args: string[], opts: { cwd?: string } = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      OPENCODE_BIN,
      ["api", ...args],
      { cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || "");
        if (err) {
          const hint =
            (err as NodeJS.ErrnoException).code === "ENOENT"
              ? `'${OPENCODE_BIN}' not found on PATH. Install OpenCode 2 or set OPENCODE_BIN.`
              : String(stderr || out || err.message).trim();
          return reject(new OpencodeError(`opencode api ${args[0]} failed`, hint));
        }
        if (!out.trim()) return resolve(undefined);
        try {
          resolve(JSON.parse(out));
        } catch {
          // Non-JSON output almost always means the request hit the web UI route
          // (wrong path) or the service returned an error page.
          reject(new OpencodeError(`opencode api ${args[0]} returned non-JSON`, out.slice(0, 200)));
        }
      },
    );
  });
}

/** Unwrap the `{ data: ... }` envelope the v2 API wraps every response in. */
function unwrap<T>(res: unknown): T {
  if (res && typeof res === "object" && "data" in (res as any)) return (res as any).data as T;
  return res as T;
}

/**
 * All sessions, filtered server-side to those rooted at `directory` when given.
 * The background service runs independently of our cwd, so the worktree must be passed
 * explicitly as the `directory` query param — it is not inferred from the client.
 */
export async function listSessions(directory?: string): Promise<Session[]> {
  const args = ["session.list"];
  if (directory) args.push("--param", `directory=${directory}`);
  return unwrap<Session[]>(await ocApi(args)) || [];
}

/** Create a session rooted at `directory` (set via the body's `location`). */
export async function createSession(directory: string, title: string): Promise<Session> {
  const body = JSON.stringify({ title, location: { directory } });
  return unwrap<Session>(await ocApi(["session.create", "-d", body]));
}

/** Send a prompt to a session. See PromptBody for the resume semantics. */
export async function prompt(
  directory: string,
  sessionID: string,
  body: PromptBody,
): Promise<unknown> {
  return ocApi(
    ["session.prompt", "--param", `sessionID=${sessionID}`, "--param", `directory=${directory}`, "-d", JSON.stringify(body)],
    { cwd: directory },
  );
}

/** Feature 1: inject a reference as context, no model reply. */
export function sendReference(
  directory: string,
  sessionID: string,
  ref: { text: string; files?: FileRef[] },
): Promise<unknown> {
  return prompt(directory, sessionID, { text: ref.text, files: ref.files, resume: false });
}

/** Feature 2: send a composed review and have OpenCode respond. */
export function sendReview(
  directory: string,
  sessionID: string,
  review: { text: string; files?: FileRef[] },
): Promise<unknown> {
  return prompt(directory, sessionID, { text: review.text, files: review.files, resume: true });
}
