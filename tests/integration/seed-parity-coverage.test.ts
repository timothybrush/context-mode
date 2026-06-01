/**
 * Seed-parity coverage gate.
 *
 * Feeds real events through attributeAndInsertEvents (which calls
 * SessionDB.getSessionRollup + bridge.maybeForward), captures every POST
 * body via a global fetch mock, and asserts the wire shape matches the
 * 32-column shape platform's seed.ts writes per event.
 *
 * If a future patch starves a column, this test goes RED with the exact
 * field name. Sister to the platform-side bridge-seed-parity test (commit
 * 36ba150 in context-mode-platform).
 */

import { describe, test, beforeEach, afterEach, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SessionDB } from "../../src/session/db.js";
import { attributeAndInsertEvents } from "../../hooks/session-loaders.mjs";

// The 32 application-layer columns the platform's seed.ts INSERTs per event.
// Order matches docs/oss-handoff.txt § Top-5 prioritization + Anomaly #3.
// Auth-derived columns (member_id, org_id, plugin) are server-side only and
// excluded — bridge does not send them.
const SEED_INSERT_COLUMNS = [
  // Identity (always populated)
  "type",         // canonical name; server coalesces to legacy `tool`
  "category",
  "ts",
  "platform",
  "project",
  // Per-event facts (derived from canonical event)
  "error",
  "session_category",
  "session_type",
  "session_data",
  // Session-wide rollup (stamped via db.getSessionRollup)
  "tool_calls",
  "errors",
  "unique_tools",
  "unique_files",
  "max_file_edits",
  "has_commit",
  "edit_test_cycles",
  "duration_min",
  "compact_count",
  "sources_indexed",
  "total_chunks",
  "search_queries",
] as const;

// Variant-specific columns — only required for matching event types.
const VARIANT_COLUMNS = {
  error: ["error_message", "error_category", "error_tool"],
  git: ["commit_message"],
  file: ["file_paths"],
} as const;

interface CapturedPost {
  url: string;
  body: Record<string, unknown>;
}

describe("seed-parity coverage gate", () => {
  let fakeHome: string;
  let dbPath: string;
  let origHome: string | undefined;
  let origXdg: string | undefined;
  let captured: CapturedPost[];
  let origFetch: typeof fetch;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "seed-parity-home-"));
    dbPath = join(fakeHome, "test.db");
    origHome = process.env.HOME;
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = fakeHome;
    delete process.env.XDG_CONFIG_HOME;

    // Valid platform.json so the gate opens
    mkdirSync(join(fakeHome, ".context-mode"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".context-mode", "platform.json"),
      JSON.stringify({
        api_key: "ctxm_parity_gate",
        platform_url: "https://capture.local/api/v1",
      }),
    );

    captured = [];
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: { body: string }) => {
      captured.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
    else delete process.env.XDG_CONFIG_HOME;
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* */ }
    vi.restoreAllMocks();
  });

  test("every outgoing event carries all 21 universal seed-parity columns", async () => {
    const db = new SessionDB({ dbPath });
    const sessionId = "parity-session-" + Date.now();
    db.ensureSession(sessionId, fakeHome);

    const events = [
      { type: "tool_use", category: "edit", data: "Edit('src/foo.ts')", priority: 2 },
      { type: "file_read", category: "file", data: "/Users/x/proj/src/foo.ts", priority: 2 },
      { type: "file_edit", category: "file", data: "/Users/x/proj/src/bar.ts", priority: 2 },
      { type: "error_tool", category: "error", data: "ENOENT: no such file or directory", priority: 1 },
      { type: "git", category: "git", data: "commit abc1234 'fix: thing'", priority: 1 },
    ];

    const resolveAttribs = (evs: { type: string }[]) =>
      evs.map(() => ({ projectDir: fakeHome, source: "input_cwd", confidence: 1 }));

    attributeAndInsertEvents(
      db,
      sessionId,
      events,
      { workspace_roots: [fakeHome] },
      fakeHome,
      "PostToolUse",
      resolveAttribs,
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(captured.length).toBe(events.length);

    // Per-event coverage: every captured body MUST carry all 21 universal columns.
    const missing: { eventIdx: number; field: string }[] = [];
    for (let i = 0; i < captured.length; i++) {
      for (const field of SEED_INSERT_COLUMNS) {
        if (!(field in captured[i].body)) {
          missing.push({ eventIdx: i, field });
        }
      }
    }

    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.log("STARVED FIELDS:", missing);
    }
    expect(missing).toEqual([]);

    db.close?.();
  });

  test("variant columns populate by category", async () => {
    const db = new SessionDB({ dbPath });
    const sessionId = "parity-variants-" + Date.now();
    db.ensureSession(sessionId, fakeHome);

    const events = [
      { type: "error_tool", category: "error", data: "ENOENT: no such file", priority: 1 },
      { type: "git",        category: "git",   data: "fix: navbar overflow", priority: 1 },
      { type: "file_edit",  category: "file",  data: "/proj/src/file.ts", priority: 2 },
    ];

    const resolveAttribs = (evs: { type: string }[]) =>
      evs.map(() => ({ projectDir: fakeHome, source: "input_cwd", confidence: 1 }));

    attributeAndInsertEvents(
      db,
      sessionId,
      events,
      { workspace_roots: [fakeHome] },
      fakeHome,
      "PostToolUse",
      resolveAttribs,
    );

    await new Promise((r) => setTimeout(r, 50));

    // error variant
    expect(captured[0].body).toHaveProperty("error_message");
    expect(captured[0].body).toHaveProperty("error_category");
    expect(captured[0].body).toHaveProperty("error_tool");
    expect(captured[0].body.error_category).toBe("file_not_found");

    // git variant
    expect(captured[1].body).toHaveProperty("commit_message");
    expect(captured[1].body.has_commit).toBe(1);

    // file variant
    expect(captured[2].body).toHaveProperty("file_paths");
    expect(Array.isArray(captured[2].body.file_paths)).toBe(true);

    db.close?.();
  });

  test("rollup snapshot reflects session-wide aggregates", async () => {
    const db = new SessionDB({ dbPath });
    const sessionId = "parity-rollup-" + Date.now();
    db.ensureSession(sessionId, fakeHome);

    // Same data + different types avoid SessionDB dedup (it uses type+data_hash).
    // Same data lets max_file_edits GROUP BY data see >1 hits per file.
    const seedBatch = [
      { type: "file_read",  category: "file", data: "/proj/a.ts",     priority: 2 },
      { type: "file_edit",  category: "file", data: "/proj/a.ts",     priority: 2 },
      { type: "file_write", category: "file", data: "/proj/a.ts",     priority: 2 },
      { type: "file_edit",  category: "file", data: "/proj/b.ts",     priority: 2 },
      { type: "error_tool", category: "error", data: "ENOENT",        priority: 1 },
      { type: "git",        category: "git",  data: "commit msg",     priority: 1 },
    ];

    const resolveAttribs = (evs: { type: string }[]) =>
      evs.map(() => ({ projectDir: fakeHome, source: "input_cwd", confidence: 1 }));

    attributeAndInsertEvents(
      db, sessionId, seedBatch,
      { workspace_roots: [fakeHome] }, fakeHome,
      "PostToolUse", resolveAttribs,
    );
    await new Promise((r) => setTimeout(r, 30));

    // The LAST captured body's rollup MUST reflect the full batch
    const last = captured[captured.length - 1].body;
    expect(last.tool_calls).toBe(seedBatch.length);
    expect(last.errors).toBe(1);
    expect(last.unique_tools).toBeGreaterThanOrEqual(4);
    expect(last.unique_files).toBeGreaterThanOrEqual(2);
    expect(last.max_file_edits).toBe(2); // /proj/a.ts was edited twice
    expect(last.has_commit).toBe(1);
    expect(typeof last.duration_min).toBe("number");

    db.close?.();
  });

  test("variant matrix — coverage report", async () => {
    const db = new SessionDB({ dbPath });
    const sessionId = "parity-matrix-" + Date.now();
    db.ensureSession(sessionId, fakeHome);

    const events = [
      { type: "tool_use",   category: "edit",  data: "Edit('x')",       priority: 2 },
      { type: "error_tool", category: "error", data: "FAIL test suite", priority: 1 },
      { type: "git",        category: "git",   data: "commit deadbeef", priority: 1 },
      { type: "file_write", category: "file",  data: "/p/new.ts",       priority: 2 },
    ];

    const resolveAttribs = (evs: { type: string }[]) =>
      evs.map(() => ({ projectDir: fakeHome, source: "input_cwd", confidence: 1 }));

    attributeAndInsertEvents(
      db, sessionId, events,
      { workspace_roots: [fakeHome] }, fakeHome,
      "PostToolUse", resolveAttribs,
    );
    await new Promise((r) => setTimeout(r, 30));

    // Compute aggregate coverage across all bodies
    const universal = SEED_INSERT_COLUMNS.length;
    const totalUniversalSlots = captured.length * universal;
    let filled = 0;
    for (const cap of captured) {
      for (const field of SEED_INSERT_COLUMNS) {
        if (field in cap.body) filled++;
      }
    }
    const coverage = filled / totalUniversalSlots;
    // eslint-disable-next-line no-console
    console.log(
      `[seed-parity coverage] universal=${filled}/${totalUniversalSlots} = ${(coverage * 100).toFixed(1)}%`,
    );

    // Gate: 100% on universal columns
    expect(coverage).toBe(1);

    db.close?.();
  });
});
