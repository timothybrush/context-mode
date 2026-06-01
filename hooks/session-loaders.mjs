/**
 * Session module loaders — bundle-first with build/ fallback.
 *
 * All session modules are loaded from esbuild bundles (hooks/session-*.bundle.mjs).
 * Bundles are built by CI (bundle.yml) and shipped with every release.
 * Fallback: if bundles are missing (marketplace installs), try build/session/*.js.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

import { hasPlatformConfig, maybeForward } from "./platform-bridge.mjs";
import { detectPlatformFromEnv } from "./core/platform-detect.mjs";

export function createSessionLoaders(hookDir) {
  // Auto-detect bundle directory: bundles live in hooks/ root, not platform subdirs.
  // If hookDir itself has bundles, use it; otherwise go up one level.
  const bundleDir = existsSync(join(hookDir, "session-db.bundle.mjs"))
    ? hookDir
    : join(hookDir, "..");

  // Fallback: if bundles missing, try build/session/*.js (marketplace installs)
  const pluginRoot = join(bundleDir, "..");
  const buildSession = join(pluginRoot, "build", "session");

  async function loadModule(bundleName, buildName) {
    const bundlePath = join(bundleDir, bundleName);
    if (existsSync(bundlePath)) {
      return await import(pathToFileURL(bundlePath).href);
    }
    const buildPath = join(buildSession, buildName);
    return await import(pathToFileURL(buildPath).href);
  }

  return {
    async loadSessionDB() {
      return await loadModule("session-db.bundle.mjs", "db.js");
    },
    async loadProjectAttribution() {
      const bundlePath = join(bundleDir, "session-attribution.bundle.mjs");
      if (existsSync(bundlePath)) {
        return await import(pathToFileURL(bundlePath).href);
      }
      const buildPath = join(buildSession, "project-attribution.js");
      if (existsSync(buildPath)) {
        return await import(pathToFileURL(buildPath).href);
      }
      // Last-resort fallback for dev environments without a fresh build.
      const localPath = join(bundleDir, "project-attribution.mjs");
      return await import(pathToFileURL(localPath).href);
    },
    async loadExtract() {
      return await loadModule("session-extract.bundle.mjs", "extract.js");
    },
    async loadSnapshot() {
      return await loadModule("session-snapshot.bundle.mjs", "snapshot.js");
    },
  };
}

/**
 * Shared helper — resolves project attributions and inserts events into the DB.
 * Eliminates the ~15-line attribution block duplicated across all hook files.
 *
 * @returns {Array} The resolved attributions array (useful when a subsequent
 *   attribution block needs `lastKnownProjectDir` from the first).
 */
export function attributeAndInsertEvents(db, sessionId, events, input, projectDir, hookName, resolveProjectAttributions) {
  const sessionStats = db.getSessionStats(sessionId);
  const lastKnownProjectDir = typeof db.getLatestAttributedProjectDir === "function"
    ? db.getLatestAttributedProjectDir(sessionId)
    : null;
  const attributions = resolveProjectAttributions(events, {
    sessionOriginDir: sessionStats?.project_dir || projectDir,
    inputProjectDir: projectDir,
    workspaceRoots: Array.isArray(input.workspace_roots) ? input.workspace_roots : [],
    lastKnownProjectDir,
  });
  // Build a parallel bytesList from event-level bytes_avoided (currently
  // populated by external_ref's ctx_fetch_and_index preamble parser). When
  // no event carries a positive value we leave bytesList undefined so
  // SessionDB falls back to its 0-default for bytes_avoided/bytes_returned
  // — preserves backward compat with older callers / tests.
  let bytesList;
  if (events.some((e) => typeof e?.bytes_avoided === "number" && e.bytes_avoided > 0)) {
    bytesList = events.map((e) =>
      typeof e?.bytes_avoided === "number" && e.bytes_avoided > 0
        ? { bytesAvoided: e.bytes_avoided }
        : undefined,
    );
  }
  // Prefer bulk path (single transaction = single WAL commit). Falls back
  // to per-event insert for older SessionDB instances that lack bulkInsertEvents.
  if (typeof db.bulkInsertEvents === "function") {
    db.bulkInsertEvents(sessionId, events, hookName, attributions, bytesList);
  } else {
    for (let i = 0; i < events.length; i++) {
      db.insertEvent(sessionId, events[i], hookName, attributions[i], bytesList?.[i]);
    }
  }

  // PRD-context-as-a-service §5.2 — Forwarder injection.
  // Gated: the per-event loop never runs when ~/.context-mode/platform.json
  // is missing. hasPlatformConfig() is a single cached probe (60s TTL), so
  // the unconfigured-user path costs at most one syscall per minute.
  if (hasPlatformConfig()) {
    const platform = detectPlatformFromEnv();
    // Session-wide rollup snapshot — stamped onto every outgoing event so
    // the analytics engine sees the seed.ts shape (tool_calls, errors,
    // unique_tools, ...). Defensive call: older SessionDB bundles that
    // predate v1.0.158 won't have getSessionRollup; fall back to null
    // and the bridge will still pass the per-event facts through.
    const rollup = typeof db.getSessionRollup === "function"
      ? db.getSessionRollup(sessionId)
      : null;

    for (let i = 0; i < events.length; i++) {
      const enriched = enrichEventForPlatform(events[i], attributions[i]);
      const payload = rollup ? { ...enriched, ...rollup } : enriched;
      maybeForward({ ...payload, session_id: sessionId }, platform);
    }
  }

  return attributions;
}

// ── Per-event enrichment (seed.ts shape parity) ──────────────────────────
//
// Each canonical event from session-extract carries only {type, category, data}.
// The platform's events table has 35 columns; the engine's aggregate SQL reads
// most of them. This helper derives the per-event-derivable subset directly
// from the event's own facts — no I/O, no classifier dependency, no allocation
// beyond the spread. Aggregates (tool_calls, errors, ...) come from the
// session rollup stamp in the caller.
//
// PRD-context-as-a-service §5.4 ABI: bridge stays a dumb pipe. This enrichment
// runs BEFORE maybeForward so the body envelope spreads the enriched event
// unchanged.
function enrichEventForPlatform(event, attribution) {
  const error = event?.category === "error" ? 1 : 0;
  const dataStr = typeof event?.data === "string" ? event.data : "";

  const enriched = {
    ...event,
    ...attribution,
    error,
    // session_* are open-string passthroughs (ADR-0001) — let the platform
    // do forensic queries on the raw shape without forcing the wide→narrow
    // category derivation to ever round-trip.
    session_category: event?.category,
    session_type: event?.type,
    session_data: dataStr.length > 0 ? dataStr.slice(0, 500) : undefined,
  };

  // Error events: surface the message + classify
  if (error === 1) {
    enriched.error_message = dataStr.slice(0, 1000);
    const cls = classifyError(dataStr);
    enriched.error_category = cls.error_category;
    enriched.error_tool = cls.error_tool;
  }

  // Git events: surface commit message + mark has_commit at the event level
  // (rollup-level has_commit comes from the session-wide stamp; both win
  // when set — `{...enriched, ...rollup}` order keeps rollup authoritative
  // for non-git events while git events stay marked).
  if (event?.category === "git" && dataStr.length > 0) {
    enriched.commit_message = dataStr.slice(0, 500);
    enriched.has_commit = 1;
  }

  // File events: ship the file path as the single-item array shape the
  // platform schema expects (Zod: z.array(z.string()).max(20))
  if (event?.category === "file" && dataStr.length > 0) {
    enriched.file_paths = [dataStr.slice(0, 500)];
  }

  return enriched;
}

// ── Inline error classifier — seed.ts ERROR_CATEGORIES parity ────────────
//
// Mirrors src/session/error-classifier.ts's 10-category table for runtime
// callers (this is a .mjs hook file; the TS classifier ships bundled but
// the bundle import path costs an extra ~20ms on first hook fire and an
// extra disk read per hook subprocess. Inline keeps the hot path fast.)
// If the table ever drifts from error-classifier.ts, the classifier test
// suite (tests/session/classifier.test.ts) is the canonical source — sync
// the patterns there first, then mirror here.
function classifyError(message) {
  const m = String(message ?? "").toLowerCase();
  if (!m) return { error_category: "unknown", error_tool: "Bash" };

  // Order matters: timeout + git_conflict checked BEFORE test_failed so
  // "test timed out" and "CONFLICT … fail" land in the right bucket.
  if (/etimedout|timed out|timeout|deadline exceeded/.test(m)) return { error_category: "timeout", error_tool: "Bash" };
  if (/conflict.*(merge|rebase|git)|merge conflict|^conflict/.test(m)) return { error_category: "git_conflict", error_tool: "Bash" };
  if (/enoent|no such file|cannot find module|filenotfounderror/.test(m)) return { error_category: "file_not_found", error_tool: "Read" };
  if (/command not found|: not found|exit code 127/.test(m)) return { error_category: "command_not_found", error_tool: "Bash" };
  if (/old_string|could not find string|matches multiple/.test(m)) return { error_category: "edit_match_failed", error_tool: "Edit" };
  if (/eacces|permission denied|operation not permitted|eperm/.test(m)) return { error_category: "permission_denied", error_tool: "Bash" };
  if (/syntaxerror|error ts\d+|unexpected token|parse error/.test(m)) return { error_category: "syntax_error", error_tool: "Bash" };
  if (/typeerror|referenceerror|rangeerror|traceback|nullpointer/.test(m)) return { error_category: "runtime_error", error_tool: "Bash" };
  if (/test failed|fail |tests failed|assertion/.test(m)) return { error_category: "test_failed", error_tool: "Bash" };
  return { error_category: "unknown", error_tool: "Bash" };
}
