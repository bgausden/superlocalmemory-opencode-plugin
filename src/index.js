// slm-memory.js — OpenCode V2 plugin for SuperLocalMemory V4 (system install).
//
// V2 shape: export default Plugin.define({ id, setup(ctx) }).
// All memory access goes through the system `slm` binary on PATH.
// Fail-open everywhere: any error returns silently so OpenCode never breaks.

import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative } from "node:path";

const execFileAsync = promisify(execFile);

const CTX_TIMEOUT_MS = 8000;
const REMEMBER_TIMEOUT_MS = 8000;
const MAX_CTX_CHARS = Number(process.env.SLM_MAX_CTX_CHARS) || 1500;
const MAX_COMPACT_CTX_CHARS = 4000;

const MEMORY_KEYWORDS = /\b(remember|don't forget|save this|note that|keep in mind|store this|memorize)\b/i;

const MEMORY_NUDGE = `[MEMORY TRIGGER DETECTED]
The user wants you to remember something. Use the superlocalmemory MCP
tools (remember) to save it.`;

// --- retrieval module (single seam, candidate 2) ---
// One interface for every shape the live V2 hooks actually send.
// Private probes below; hooks and tests go through `retrieval` only.
function isRecord(v) {
  return typeof v === "object" && v !== null;
}

function messageText(m) {
  // Live Message carries content: ContentPart[]. No parts/text probe —
  // no producer sends those shapes.
  if (!isRecord(m)) return "";
  const c = m.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (isRecord(p) && typeof p.text === "string") return p.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function lastUserText(messages) {
  // Latest user-role message wins, even when it carries no text (e.g. a
  // media-only message). Falling back to an older message would feed a stale
  // query to session-context, so a textless latest message means "" (skip
  // recall this turn) rather than a stale question. Non-user roles are still
  // skipped so mid-loop tool continuations reuse the triggering question.
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isRecord(m)) continue;
    if (m.role && m.role !== "user") continue;
    return messageText(m);
  }
  return "";
}

function patchPaths(patchText) {
  // patch tool embeds target paths in section headers (see @opencode/util
  // patch.js): *** Add File: / *** Update File: / *** Delete File: plus
  // *** Move to: for renames. Headers match on the trimmed line.
  if (typeof patchText !== "string") return [];
  const out = [];
  for (const raw of patchText.split("\n")) {
    const line = raw.trim();
    for (const prefix of ["*** Add File:", "*** Update File:", "*** Delete File:"]) {
      if (line.startsWith(prefix)) {
        const p = line.slice(prefix.length).trim();
        if (p) out.push(p);
      }
    }
    if (line.startsWith("*** Move to:")) {
      const p = line.slice("*** Move to:".length).trim();
      if (p) out.push(p);
    }
  }
  return out;
}

export const retrieval = {
  // Conversation text for the context hook: latest user message text.
  // Live SessionContext carries messages/system; no other producer exists
  // since the prompt hook was dropped, so no direct-payload fallback.
  text(payload) {
    if (!isRecord(payload)) return "";
    return lastUserText(payload.messages);
  },
  // Session identity for context + subscribe events. Live shapes carry
  // sessionID top-level (hooks) or under data (events); || skips empties.
  sessionID(payload) {
    if (!isRecord(payload)) return undefined;
    return payload.sessionID || payload.data?.sessionID || undefined;
  },
  // Every file path a tool input touches. Live shapes: path (read/write/
  // edit) and patchText-embedded paths (patch: Add/Update/Delete/Move).
  // filePath/file_path spellings kept for recent-rename and snake_case
  // (MCP) producers. V1 args.*/tool_input.* nesting deleted — no producer.
  filePaths(input) {
    if (!isRecord(input)) return [];
    const out = [];
    const push = (v) => {
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    };
    push(input.path);
    push(input.filePath);
    push(input.file_path);
    for (const p of patchPaths(input.patchText)) push(p);
    return [...new Set(out)];
  },
};

// --- slm gateway errors (tagged, explicit fail-open) ---
// Every slm subprocess failure is classified, never swallowed to "". The
// recall path branches on the classification (degraded-mode notice below);
// the fire-and-forget and git-probe paths drop explicitly. An Effect
// migration would lift these tags into the error channel — note the effect
// flavor is a separate entry point (`effect`, not `setup`) whose
// `Effect<void, never, R>` signature closes that channel with Scope
// finalizers instead of our AbortController cleanup.
const slmBin = () => process.env.SLM_BIN || "slm";

export function classifySlmError(err, { timeout = CTX_TIMEOUT_MS } = {}) {
  // Node sets killed:true only when IT killed the child (our timeout path —
  // no killSignal override or AbortSignal in play). A self-signalled child
  // has killed:false and must not be reported as our budget expiring.
  if (isRecord(err) && err.killed === true) {
    return { tag: "timeout", timeoutMs: timeout };
  }
  if (isRecord(err) && (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EPERM")) {
    return { tag: "spawn", code: err.code };
  }
  if (isRecord(err) && err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { tag: "overflow", limitBytes: 256 * 1024 };
  }
  if (isRecord(err) && (typeof err.code === "number" || typeof err.signal === "string")) {
    const stderr =
      typeof err.stderr === "string" ? err.stderr.trim().slice(0, 500) : "";
    return { tag: "exit", code: err.code ?? err.signal, stderr };
  }
  // Never a black hole: carry whatever the runtime said.
  const message = (() => {
    try {
      const m = isRecord(err) ? err.message : err;
      return typeof m === "string" ? m.slice(0, 200) : String(m).slice(0, 200);
    } catch {
      return "";
    }
  })();
  const code = isRecord(err) && err.code !== undefined ? String(err.code) : "";
  return { tag: "unknown", code, message };
}

// Degraded-mode monitor: repeated recall failures surface ONE short system
// line so dead-binary is distinguishable from no-memories at the model
// boundary, then stay quiet until a success re-arms. Pure factory, tested.
export function createGatewayMonitor({ threshold = 3 } = {}) {
  let consecutive = 0;
  let lastError;
  return {
    failure(error) {
      consecutive += 1;
      lastError = error;
      if (consecutive === threshold) return true;
      return false;
    },
    success() {
      consecutive = 0;
      lastError = undefined;
    },
    status() {
      return { consecutive, lastError };
    },
  };
}

export async function runSlmStrict(args, { timeout = CTX_TIMEOUT_MS, exec = execFileAsync } = {}) {
  try {
    const { stdout } = await exec(slmBin(), args, {
      timeout,
      maxBuffer: 256 * 1024,
    });
    return { ok: true, stdout: (stdout || "").trim() };
  } catch (err) {
    return { ok: false, error: classifySlmError(err, { timeout }) };
  }
}

function truncate(s, max = MAX_CTX_CHARS) {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

async function sessionContext(query, max = MAX_CTX_CHARS) {
  const q = (query || "").slice(0, 500) || "general";
  const r = await runSlmStrict(["session-context", q], { timeout: CTX_TIMEOUT_MS });
  // Explicit fail-open: no memories and a dead binary both yield no context,
  // but the distinction survives in `error` for callers that care.
  if (!r.ok) return { ok: false, text: "", error: r.error };
  return { ok: true, text: truncate(r.stdout, max), error: undefined };
}

// Short guard window: session.idle and session.status/idle both fire for
// the same turn (~simultaneously), while real turns are model round-trips
// apart. session.compacted is live (session-compaction-event) and counts as
// a milestone worth one summary.
const END_SUMMARY_DEDUPE_MS = 5000;

export function isSessionEndEvent(event) {
  // Live turn-end signals are session.execution.succeeded/failed/interrupted
  // (data.sessionID, durable). The session.idle/status/compacted members of
  // the V2Event union are kept as fallback — this server's stream has only
  // been observed to emit the execution.* family.
  if (!isRecord(event)) return false;
  if (
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted"
  )
    return true;
  if (event.type === "session.idle") return true;
  if (event.type === "session.compacted") return true;
  if (event.type === "session.status") {
    return event.data?.status?.type === "idle";
  }
  return false;
}

export { patchPaths };

// Fire-and-forget remember; never await in hot path longer than timeout.
// Explicit fail-open: a failed write is dropped on purpose, not lost in a
// swallowed empty string.
async function remember(content, tags = "opencode-hook") {
  if (!content?.trim()) return;
  const r = await runSlmStrict(["remember", "--tags", tags, content.slice(0, 2000)], {
    timeout: REMEMBER_TIMEOUT_MS,
  });
  if (!r.ok) return;
}

// --- touch log + end summary (single seam, rollup) ---
// The tool hook only accumulates touched paths per session; one enriched
// summary is written per idle turn. Both halves are pure and exported so
// hook logic stays testable.
export function createTouchLog() {
  const touched = new Map();
  return {
    touch(key, paths) {
      if (!key || !Array.isArray(paths)) return;
      let list = touched.get(key);
      if (!list) {
        list = [];
        touched.set(key, list);
      }
      for (const p of paths) {
        if (p && !list.includes(p)) list.push(p);
      }
    },
    take(key) {
      const list = touched.get(key) || [];
      touched.delete(key);
      return list;
    },
    peek(key) {
      return [...(touched.get(key) || [])];
    },
  };
}

const MAX_SUMMARY_FILES = 20;
const MAX_COMMIT_SUBJECT = 100;

function localTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Fields ordered by recall value — remember() slices at 2000 chars, so the
// most expendable (recent commits) goes last.
export function formatEndSummary({ projectName, at, branch, files, diff, sessionID, commits }) {
  const lines = [`[${projectName}] opencode session ended ${at}`];
  if (branch) lines.push(`branch: ${branch}`);
  if (files.length > 0) {
    const shown = files.slice(0, MAX_SUMMARY_FILES);
    lines.push(
      files.length > shown.length
        ? `files: ${shown.length} of ${files.length}: ${shown.join(", ")}`
        : `files: ${shown.join(", ")}`
    );
  }
  if (diff) lines.push(`uncommitted: ${diff}`);
  if (sessionID) lines.push(`session: ${sessionID}`);
  for (const c of commits.slice(0, 5)) {
    lines.push(`recent: ${c.slice(0, MAX_COMMIT_SUBJECT)}`);
  }
  return lines.join(" | ");
}

// --- end-summary write gate (token-spend throttle) ---
// The daemon bills cloud LLM per remembered fact (enrichment +
// disambiguation + summaries), so timestamp-only and duplicate summaries are
// pure spend. Three guards, all plugin-side (no SLM fork):
// 1. Writer rule: only a project with touched files writes. This stops the
//    observed N-project fan-out where every idle project echoes the same
//    session once a minute. It subsumes the empty-summary skip (no files +
//    no diff + no commits) since files-empty always skips.
// 2. Change gate: skip when the files/diff/commits/branch hash matches the
//    last write for this key.
// 3. Min interval: skip until END_SUMMARY_MIN_INTERVAL_MS has passed since
//    the last write for this key.
// Skipped turns cost nothing and lose nothing: the caller only peek()s
// touches and take()s on write, so skipped content accumulates into the
// next write.
// Write-vs-ack semantics: the caller markWritten()s synchronously when it
// decides to write, BEFORE the fire-and-forget remember() resolves (it is
// never awaited by design). A failed write therefore still advances the
// throttle. That is correct for spend-gating — a struggling daemon must not
// cause a retry storm — but it means a daemon outage silences retries for
// this key until the min interval passes AND content changes.
// Pure factory, tested.
export function parseEndSummaryMinIntervalMs(raw, fallback = 15 * 60 * 1000) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n; // 0 disables the min-interval check; the change gate still applies.
}
export const END_SUMMARY_MIN_INTERVAL_MS = parseEndSummaryMinIntervalMs(
  process.env.SLM_END_SUMMARY_MIN_INTERVAL_MS
);

export function endSummaryHash({ branch = "", files = [], diff = "", commits = [] } = {}) {
  return JSON.stringify({ branch, files, diff, commits });
}

export function createEndSummaryGate({ minIntervalMs = END_SUMMARY_MIN_INTERVAL_MS, maxKeys = 100 } = {}) {
  const seen = new Map();
  return {
    shouldWrite(key, hash, now = Date.now()) {
      const k = key || "unknown";
      const last = seen.get(k);
      if (!last) return true;
      if (now - last.at < minIntervalMs) return false;
      if (last.hash === hash) return false;
      return true;
    },
    markWritten(key, hash, now = Date.now()) {
      const k = key || "unknown";
      if (seen.size > maxKeys) seen.clear();
      seen.set(k, { at: now, hash });
    },
  };
}

export default Plugin.define({
  id: "slm-memory",
  async setup(ctx) {
    const projectDir =
      ctx.location?.directory || ctx.location?.project?.directory || process.cwd();
    const projectName =
      String(projectDir).split("/").filter(Boolean).pop() || "general";
    // Single injection module owning the first-seen seam (candidate 1).
    // One interface, one place to test: claim() returns true exactly once
    // per key. Only the context hook claims; no prompt hook pre-marking.
    const firstSeen = (() => {
      const seen = new Set();
      return {
        claim(key) {
          const k = key || "unknown";
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        },
      };
    })();

    // Background recall: model-only system context, not echoed as user text.
    // Gateway failures feed the degraded-mode monitor: after `threshold`
    // consecutive recall failures one short notice is injected so a dead
    // backend is distinguishable from genuinely-empty memory, then silence
    // until a success re-arms. Only recall-path failures count — background
    // writes stay fire-and-forget by design.
    const gateway = createGatewayMonitor();
    // Hook registrations are scoped to the plugin's lifetime: the host
    // disposes them on unload (see @opencode/plugin adapter: "Hook
    // registrations created during the async `setup` attach to the plugin's
    // scope, so unloading the plugin disposes them"). The returned
    // registrations are therefore intentionally not retained. The cleanup
    // returned from setup also aborts the event-subscribe controller — the
    // host would close that iterator on unload anyway, but prompt teardown
    // stops our loop without waiting for it.
    await ctx.session.hook("context", async (event) => {
      try {
        const text = retrieval.text(event);
        if (!text.trim()) return;
        const additions = [];

        if (MEMORY_KEYWORDS.test(text.replace(/```[\s\S]*?```/g, ""))) {
          additions.push(MEMORY_NUDGE);
        }

        const sessionID = event?.sessionID || retrieval.sessionID(event);
        const key = sessionID || text.slice(0, 64) || "unknown";
        const isFirst = firstSeen.claim(key);

        const r = await sessionContext(text);
        if (r.ok) {
          gateway.success();
          if (r.text) {
            additions.push(
              `<slm-memory status="background">\nFor model use only; do not quote verbatim unless directly relevant.\n\n${r.text}\n</slm-memory>`
            );
          }
        } else if (gateway.failure(r.error)) {
          additions.push(
            `SLM memory backend unavailable (${r.error.tag}); continuing without recalled context.`
          );
        }
        if (isFirst) {
          additions.push(
            `## SLM Session Init\nFor memory-aware sessions, call superlocalmemory MCP session_init with project_path='${projectDir}' and a topic from the user's first message.`
          );
        }

        if (additions.length > 0 && Array.isArray(event?.system)) {
          event.system.push({ type: "text", text: additions.join("\n\n") });
        }
      } catch {}
    });

    // File-touch bookkeeping only: accumulate project-relative paths per
    // session for the end-of-turn summary. Zero subprocesses here.
    const touches = createTouchLog();
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        if (event?.status !== "completed") return;
        const tool = String(event?.tool || "").toLowerCase();
        if (!/^(edit|write|patch)$/.test(tool)) return;
        if (!event?.sessionID) return;
        const rel = [];
        for (const fp of retrieval.filePaths(event?.input)) {
          const r = relative(projectDir, fp);
          rel.push(r && !r.startsWith("..") ? r : fp);
        }
        touches.touch(event.sessionID, rel);
      } catch {}
    });

    // Mirrors Siim preemptive-compaction injection, sourced from system SLM.
    // V1 was "experimental.session.compacting"; V2 is session "compaction".
    await ctx.session.hook("compaction", async (event) => {
      try {
        const r = await sessionContext(projectName, MAX_COMPACT_CTX_CHARS);
        // Explicit drop, no notice: compaction must never gain new failure
        // text, and the recall-path monitor already counts the failure.
        if (!r.ok) {
          gateway.failure(r.error);
          return;
        }
        gateway.success();
        if (!r.text) return;
        const prompt =
          `[SESSION COMPACTION — SLM PROJECT KNOWLEDGE]\nPreserve task status, decisions, files touched, and blockers.\n\n${r.text}`;
        if (Array.isArray(event?.system)) {
          event.system.push({ type: "text", text: prompt });
        }
      } catch {}
    });

    // Session end -> rich summary (mirrors Claude `slm hook stop`).
    // V2 is ctx.event.subscribe(). session.idle and session.status/idle both
    // fire for the same turn, so the short guard window collapses the
    // duplicate while real turns (model round-trips apart) pass through.
    // Write gate (token-spend throttle): only the project(s) with touched
    // files write, only on changed content, at most once per
    // END_SUMMARY_MIN_INTERVAL_MS per key. Turns only peek() touches and
    // take() on write, so skips accumulate instead of dropping. Pruned on
    // write: one entry per recently-ended session.
    const endGate = createEndSummaryGate();
    const endDedupeAt = new Map();
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            if (!isSessionEndEvent(event)) continue;
            const sessionID = retrieval.sessionID(event);
            const key = sessionID || projectDir;
            // Short duplicate-event collapse first (cheap, no subprocesses,
            // touches preserved — take() is not called on this path).
            const lastDedupe = endDedupeAt.get(key) || 0;
            if (Date.now() - lastDedupe < END_SUMMARY_DEDUPE_MS) continue;
            endDedupeAt.set(key, Date.now());
            if (endDedupeAt.size > 100) endDedupeAt.clear();
            const files = touches.peek(sessionID || "");
            // Guard 1 (writer rule + empty skip): no touched files here means
            // this project did nothing this turn — stay silent without even
            // paying for the three git probes below. This kills the observed
            // once-a-minute timestamp-only fan-out across idle projects.
            // peek() (not take()) so skipped touches stay queued.
            if (files.length === 0) continue;
            let branch = "";
            let diff = "";
            let log = [];
            // Deliberately unclassified: these probes degrade to absent
            // summary sections (a missing branch: line is still a true
            // summary), so classification would add branches no caller reads.
            try {
              const [b, d, l] = await Promise.all([
                execFileAsync("git", ["-C", projectDir, "branch", "--show-current"], {
                  timeout: 5000,
                })
                  .then((r) => (r.stdout || "").trim())
                  .catch(() => ""),
                execFileAsync("git", ["-C", projectDir, "diff", "--stat"], { timeout: 5000 })
                  .then((r) => (r.stdout || "").trim().split("\n").pop() || "")
                  .catch(() => ""),
                execFileAsync(
                  "git",
                  ["-C", projectDir, "log", "--oneline", "-5", "--since=3 hours ago"],
                  { timeout: 5000 }
                )
                  .then((r) => (r.stdout || "").trim().split("\n").filter(Boolean))
                  .catch(() => []),
              ]);
              branch = b;
              diff = d;
              log = l;
            } catch {}
            // Guards 2+3 (change gate + min interval): skip unchanged or
            // too-soon summaries. Touches were only peeked, so they stay
            // queued and accumulate into the next write.
            const hash = endSummaryHash({ branch, files, diff, commits: log });
            if (!endGate.shouldWrite(key, hash)) continue;
            // Drain only on write so a skipped turn loses nothing.
            const drained = touches.take(sessionID || "");
            const summary = formatEndSummary({
              projectName,
              at: localTimestamp(),
              branch,
              files: drained.length > 0 ? drained : files,
              diff,
              sessionID,
              commits: log,
            });
            endGate.markWritten(key, hash);
            // Marked BEFORE remember() resolves (fire-and-forget, never
            // awaited): a failed write still advances the throttle, so a
            // daemon outage silences retries for this key until the min
            // interval passes and content changes. Deliberate spend-gating.
            remember(summary, "opencode-session-stop").catch(() => {});
          } catch {}
        }
      } catch {}
    })();

    return () => controller.abort();
  },
});
