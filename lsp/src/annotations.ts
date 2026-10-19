/**
 * Mapping annotations to (a) LSP diagnostics that render the in-editor review list and
 * (b) the Markdown text sent to OpenCode for feature 1 (single reference) and feature 2
 * (a composed review of many annotations).
 */
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Annotation } from "./types.ts";
import type { FileRef } from "./opencode.ts";

export const DIAGNOSTIC_SOURCE = "opencode";

/** `path:startLine-endLine`, 1-based and relative to the worktree, e.g. `src/auth.ts:42-48`. */
export function refLabel(worktree: string, ann: Annotation): string {
  const rel = relative(worktree, ann.file) || ann.file;
  const start = ann.range.start.line + 1;
  const end = ann.range.end.line + 1;
  return end > start ? `${rel}:${start}-${end}` : `${rel}:${start}`;
}

/** One diagnostic per annotation: gutter marker + a row in the Project Diagnostics panel. */
export function toDiagnostic(ann: Annotation): Diagnostic {
  const body = ann.comment.trim() || ann.quote.split("\n")[0]?.trim() || "annotation";
  return {
    range: ann.range,
    severity: DiagnosticSeverity.Information,
    source: DIAGNOSTIC_SOURCE,
    message: `📌 ${body}`,
    code: ann.id,
  };
}

/** Group annotations into `uri -> Diagnostic[]` for publishDiagnostics. */
export function diagnosticsByFile(annotations: Annotation[]): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>();
  for (const ann of annotations) {
    const uri = pathToFileURL(ann.file).toString();
    const list = out.get(uri) ?? [];
    list.push(toDiagnostic(ann));
    out.set(uri, list);
  }
  return out;
}

function fenced(ann: Annotation): string {
  const lang = ann.language || "";
  return "```" + lang + "\n" + ann.quote.replace(/```/g, "ˋˋˋ") + "\n```";
}

/** Feature 1: a single reference block (header + quoted snippet). */
export function renderReference(worktree: string, ann: Annotation): string {
  return `From Zed — \`${refLabel(worktree, ann)}\`:\n\n${fenced(ann)}`;
}

/** Feature 2: a full review composed from all annotations. */
export function renderReview(worktree: string, annotations: Annotation[]): string {
  const lines: string[] = [
    `Code review from Zed (${annotations.length} ${annotations.length === 1 ? "note" : "notes"}). Please address each:`,
    "",
  ];
  annotations.forEach((ann, i) => {
    lines.push(`### ${i + 1}. \`${refLabel(worktree, ann)}\``);
    if (ann.comment.trim()) lines.push("", ann.comment.trim());
    lines.push("", fenced(ann), "");
  });
  return lines.join("\n").trimEnd();
}

/** Unique `file://` uris across annotations, so OpenCode can open the full files. */
export function fileRefs(annotations: Annotation[]): FileRef[] {
  const seen = new Set<string>();
  const refs: FileRef[] = [];
  for (const ann of annotations) {
    const uri = pathToFileURL(ann.file).toString();
    if (seen.has(uri)) continue;
    seen.add(uri);
    refs.push({ uri, name: ann.file.split("/").pop() });
  }
  return refs;
}
