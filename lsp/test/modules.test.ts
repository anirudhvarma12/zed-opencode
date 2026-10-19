import { test, expect } from "bun:test";
import { Store } from "../src/state.ts";
import { renderScratch, parseScratch } from "../src/scratch.ts";
import { renderReview, refLabel, diagnosticsByFile } from "../src/annotations.ts";
import type { Annotation } from "../src/types.ts";

const WT = "/tmp/zed-oc-unit-" + Math.floor(performance.now());
const ann = (id: string, comment = ""): Annotation => ({
  id,
  file: WT + "/src/auth.ts",
  range: { start: { line: 41, character: 0 }, end: { line: 47, character: 0 } },
  quote: "const x = await f()",
  language: "typescript",
  comment,
  created: 1,
});

test("refLabel is 1-based and relative to the worktree", () => {
  expect(refLabel(WT, ann("a"))).toBe("src/auth.ts:42-48");
});

test("store persists pin + annotations across instances", () => {
  const s1 = new Store();
  s1.pin(WT, "ses_123", "My session");
  s1.addAnnotation(WT, ann("a"));
  const st = new Store().get(WT);
  expect(st.pinnedSessionID).toBe("ses_123");
  expect(st.annotations.length).toBe(1);
});

test("scratch round-trip recovers typed comments, drops the placeholder", () => {
  const st = {
    pinnedSessionID: "ses_123",
    pinnedSessionTitle: "My session",
    annotations: [ann("a"), ann("b")],
  };
  const md = renderScratch(WT, st).replace("_Type your review comment here…_", "avoid nested await");
  const parsed = parseScratch(md);
  expect(parsed.get("a")).toBe("avoid nested await");
  expect(parsed.get("b")).toBe("");
});

test("renderReview composes numbered notes with comments + fenced code", () => {
  const txt = renderReview(WT, [ann("a", "fix this"), ann("b")]);
  expect(txt).toContain("### 1. `src/auth.ts:42-48`");
  expect(txt).toContain("fix this");
  expect(txt).toContain("```typescript");
});

test("diagnosticsByFile groups by file uri with the 📌 message", () => {
  const m = diagnosticsByFile([ann("a", "c1"), ann("b")]);
  const [uri, diags] = [...m][0]!;
  expect(uri.startsWith("file://")).toBe(true);
  expect(diags[0]!.message).toBe("📌 c1");
});
