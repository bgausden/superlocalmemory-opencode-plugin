// slm-memory.js — OpenCode V2 plugin for SuperLocalMemory V4 (system install).
//
// V2 shape: export default Plugin.define({ id, setup(ctx) }).
// All memory access goes through the system `slm` binary on PATH.
// Fail-open everywhere: any error returns silently so OpenCode never breaks.

import { Plugin } from "@opencode/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

const SLM_BIN = process.env.SLM_BIN || "slm";
const CTX_TIMEOUT_MS = 8000;
const REMEMBER_TIMEOUT_MS = 8000;
const MAX_CTX_CHARS = Number(process.env.SLM_MAX_CTX_CHARS) || 1500;
const MAX_COMPACT_CTX_CHARS = 4000;
const OBSERVE_COOLDOWN_MS = 5 * 60 * 1000;

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

function readString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function messageText(m) {
  if (!isRecord(m)) return "";
  const c = m.content ?? m.parts ?? m.text;
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
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isRecord(m)) continue;
    if (m.role && m.role !== "user") continue;
    const text = messageText(m);
    if (text) return text;
  }
  return "";
}

export const retrieval = {
  // Conversation text for the context hook: last user message, else a
  // direct text payload. V1 envelope probes (properties/event/message/parts)
  // deleted — the live SessionContext event carries messages/system.
  text(payload) {
    if (!isRecord(payload)) return "";
    const fromMessages = lastUserText(payload.messages);
    if (fromMessages) return fromMessages;
    const c = payload;
    const values = [c.prompt?.text, c.text, c.prompt, c.content];
    return values.map(readString).find(Boolean) ?? "";
  },
  // Session identity for context + subscribe events. Live shapes carry
  // sessionID directly or under data; V1 properties/path probes deleted.
  sessionID(payload) {
    if (!isRecord(payload)) return undefined;
    return payload.sessionID ?? payload.sessionId ?? payload.data?.sessionID;
  },
  // File path from tool input. Live shape is the direct args object;
  // V1 properties/event nesting deleted.
  filePath(input) {
    if (!isRecord(input)) return "";
    const candidates = [
      input?.filePath,
      input?.path,
      input?.file_path,
      input?.args?.filePath,
      input?.args?.path,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
    const nested = input?.tool_input;
    if (isRecord(nested)) {
      const fp = nested.file_path || nested.filePath || nested.path;
      if (typeof fp === "string" && fp.trim()) return fp.trim();
    }
    return "";
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

function cooldownPath(key) {
  const h = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(tmpdir(), `slm-opencode-obs-${h}`);
}

function cooldownElapsed(path, cooldownMs) {
  try {
    if (!existsSync(path)) return true;
    const ts = Number(readFileSync(path, "utf8").trim());
    return Date.now() - ts > cooldownMs;
  } catch {
    return true;
  }
}

function markCooldown(path) {
  try {
    writeFileSync(path, String(Date.now()));
  } catch {}
}

function isSessionEndEvent(event) {
  if (!isRecord(event)) return false;
  const t = event.type;
  if (t === "session.idle" || t === "session.compacted") return true; // V1 names
  if (t === "session.compacted" && event?.data?.sessionID) return true;
  if (t === "session.status" && event?.data?.status?.type === "idle") return true;
  if (t === "session.status" && event?.data?.sessionID) {
    // Only treat idle as end; busy/retry are not ends.
    return event.data.status?.type === "idle";
  }
  return false;
}

// Fire-and-forget remember; never await in hot path longer than timeout.
async function remember(content, tags = "opencode-hook") {
  if (!content?.trim()) return;
  await runSlm(["remember", "--tags", tags, content.slice(0, 2000)], {
    timeout: REMEMBER_TIMEOUT_MS,
  });
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

    // Mirrors Claude PostToolUse checkpoint: cooldown-gated auto-observe.
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        const tool = String(event?.tool || "").toLowerCase();
        const fp = retrieval.filePath(event?.input);
        if (!/(edit|write|create|apply_patch)/.test(tool) && !fp) return;
        if (!fp) return;
        const basename = fp.split("/").pop();
        const cdPath = cooldownPath(`file:${fp}`);
        if (!cooldownElapsed(cdPath, OBSERVE_COOLDOWN_MS)) return;
        markCooldown(cdPath);
        remember(`File changed: ${basename} (${fp})`, "hook-file-change,opencode").catch(() => {});
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
    // V1 was `event` hook; V2 is ctx.event.subscribe().
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            if (!isSessionEndEvent(event)) continue;
            const sessionID = retrieval.sessionID(event);
            let branch = "";
            let diff = "";
            try {
              const [b, d] = await Promise.all([
                execFileAsync("git", ["-C", projectDir, "branch", "--show-current"], {
                  timeout: 5000,
                })
                  .then((r) => (r.stdout || "").trim())
                  .catch(() => ""),
                execFileAsync("git", ["-C", projectDir, "diff", "--stat"], { timeout: 5000 })
                  .then((r) => (r.stdout || "").trim().split("\n").pop() || "")
                  .catch(() => ""),
              ]);
              branch = b;
              diff = d;
            } catch {}
            const parts = [`[${projectName}] opencode session ended`];
            if (branch) parts.push(`branch: ${branch}`);
            if (diff) parts.push(`uncommitted: ${diff}`);
            if (sessionID) parts.push(`session: ${sessionID}`);
            remember(parts.join(" | "), "opencode-session-stop").catch(() => {});
          } catch {}
        }
      } catch {}
    })();

    return () => controller.abort();
  },
});
