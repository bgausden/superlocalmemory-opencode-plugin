// slm-memory.js — OpenCode V2 plugin for SuperLocalMemory V4 (system install).
//
// V2 shape: export default Plugin.define({ id, setup(ctx) }).
// All memory access goes through the system `slm` binary on PATH.
// Fail-open everywhere: any error returns silently so OpenCode never breaks.

import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir, } from "node:os";
import { join, relative } from "node:path";
import { appendFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

const SLM_BIN = process.env.SLM_BIN || "slm";
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

async function runSlm(args, { timeout = CTX_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFileAsync(SLM_BIN, args, {
      timeout,
      maxBuffer: 256 * 1024,
    });
    return (stdout || "").trim();
  } catch {
    return "";
  }
}

function truncate(s, max = MAX_CTX_CHARS) {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

async function sessionContext(query, max = MAX_CTX_CHARS) {
  const q = (query || "").slice(0, 500) || "general";
  const out = await runSlm(["session-context", q], { timeout: CTX_TIMEOUT_MS });
  return truncate(out, max);
}

// Short guard window: session.idle and session.status/idle both fire for
// the same turn (~simultaneously), while real turns are model round-trips
// apart. session.compacted is live (session-compaction-event) and counts as
// a milestone worth one summary.
const END_SUMMARY_DEDUPE_MS = 5000;

export function isSessionEndEvent(event) {
  if (!isRecord(event)) return false;
  if (event.type === "session.idle") return true;
  if (event.type === "session.compacted") return true;
  if (event.type === "session.status") {
    return event.data?.status?.type === "idle";
  }
  return false;
}

export { patchPaths };

// Fire-and-forget remember; never await in hot path longer than timeout.
async function remember(content, tags = "opencode-hook") {
  if (!content?.trim()) return;
  await runSlm(["remember", "--tags", tags, content.slice(0, 2000)], {
    timeout: REMEMBER_TIMEOUT_MS,
  });
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

        const slmCtx = await sessionContext(text);
        if (slmCtx) {
          additions.push(
            `<slm-memory status="background">\nFor model use only; do not quote verbatim unless directly relevant.\n\n${slmCtx}\n</slm-memory>`
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
        const slmCtx = await sessionContext(projectName, MAX_COMPACT_CTX_CHARS);
        if (!slmCtx) return;
        const prompt =
          `[SESSION COMPACTION — SLM PROJECT KNOWLEDGE]\nPreserve task status, decisions, files touched, and blockers.\n\n${slmCtx}`;
        if (Array.isArray(event?.system)) {
          event.system.push({ type: "text", text: prompt });
        }
      } catch {}
    });

    // Session end -> rich summary (mirrors Claude `slm hook stop`).
    // V2 is ctx.event.subscribe(). session.idle and session.status/idle both
    // fire for the same turn, so the short guard window collapses the
    // duplicate while real turns (model round-trips apart) pass through.
    // Pruned on write: one entry per recently-ended session.
    const endSummaries = new Map();
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            // TEMPORARY flush-path verification: log every received event.
            try {
              appendFileSync(
                join(tmpdir(), "slm-memory-events.log"),
                `${new Date().toISOString()} ${event?.type}\n`
              );
            } catch {}
            if (!isSessionEndEvent(event)) continue;
            const sessionID = retrieval.sessionID(event);
            const key = sessionID || projectDir;
            const last = endSummaries.get(key) || 0;
            if (Date.now() - last < END_SUMMARY_DEDUPE_MS) continue;
            if (endSummaries.size > 100) endSummaries.clear();
            const files = touches.take(sessionID || "");
            let branch = "";
            let diff = "";
            let log = [];
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
            const summary = formatEndSummary({
              projectName,
              at: localTimestamp(),
              branch,
              files,
              diff,
              sessionID,
              commits: log,
            });
            endSummaries.set(key, Date.now());
            remember(summary, "opencode-session-stop").catch(() => {});
          } catch {}
        }
      } catch {}
    })();

    return () => controller.abort();
  },
});
