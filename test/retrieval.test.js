import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retrieval, patchPaths, isSessionEndEvent, createTouchLog, formatEndSummary, endSummaryHash, createEndSummaryGate, END_SUMMARY_MIN_INTERVAL_MS } from "../src/index.js";

describe("retrieval.text", () => {
  it("returns the last user message, skipping system/assistant/tool", () => {
    const event = {
      sessionID: "ses_1",
      system: [],
      messages: [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "tool", content: [{ type: "text", text: "result" }] },
        { role: "user", content: [{ type: "text", text: "remember this" }] },
      ],
    };
    assert.equal(retrieval.text(event), "remember this");
  });

  it("does not fall back to a stale message for media-only input", () => {
    const event = {
      messages: [
        { role: "user", content: [{ type: "text", text: "older question" }] },
        {
          role: "user",
          content: [{ type: "media", media: { source: { type: "url", url: "https://x/y.png" } } }],
        },
      ],
    };
    assert.equal(retrieval.text(event), "");
  });

  it("returns empty when there is no user text", () => {
    assert.equal(retrieval.text({ messages: [] }), "");
    assert.equal(retrieval.text({}), "");
    assert.equal(retrieval.text(null), "");
  });
});

describe("retrieval.sessionID", () => {
  it("reads hook and event envelopes, skipping empties", () => {
    assert.equal(retrieval.sessionID({ sessionID: "a" }), "a");
    assert.equal(retrieval.sessionID({ data: { sessionID: "b" } }), "b");
    assert.equal(retrieval.sessionID({}), undefined);
  });
});

describe("retrieval.filePaths", () => {
  it("reads path-only edit/write input", () => {
    assert.deepEqual(retrieval.filePaths({ path: "a/b" }), ["a/b"]);
    assert.deepEqual(retrieval.filePaths({ filePath: "c" }), ["c"]);
  });

  it("parses patch-embedded targets", () => {
    const patchText = [
      "*** Update File: src/old.ts",
      "+++ content",
    ].join("\n");
    assert.deepEqual(retrieval.filePaths({ patchText }), ["src/old.ts"]);
  });

  it("returns empty when absent", () => {
    assert.deepEqual(retrieval.filePaths({}), []);
    assert.deepEqual(retrieval.filePaths(null), []);
  });
});

describe("patchPaths", () => {
  it("reads add, update, and delete headers", () => {
    const patchText = [
      "*** Add File: new/f.ts",
      "*** Update File: src/old.ts",
      "*** Delete File: gone/f.ts",
    ].join("\n");
    assert.deepEqual(patchPaths(patchText), [
      "new/f.ts",
      "src/old.ts",
      "gone/f.ts",
    ]);
  });

  it("reads move destinations and tolerates indentation", () => {
    const patchText = [
      "*** Update File: a.ts",
      "  *** Move to: b.ts",
    ].join("\n");
    assert.deepEqual(patchPaths(patchText), ["a.ts", "b.ts"]);
  });

  it("returns empty for non-patch input", () => {
    assert.deepEqual(patchPaths("just some text"), []);
    assert.deepEqual(patchPaths(null), []);
  });
});

describe("isSessionEndEvent", () => {
  it("matches live end signals only", () => {
    assert.equal(
      isSessionEndEvent({ type: "session.execution.succeeded" }),
      true
    );
    assert.equal(isSessionEndEvent({ type: "session.execution.failed" }), true);
    assert.equal(
      isSessionEndEvent({ type: "session.execution.interrupted" }),
      true
    );
    assert.equal(isSessionEndEvent({ type: "session.execution.started" }), false);
    assert.equal(isSessionEndEvent({ type: "session.compacted" }), true);
    assert.equal(
      isSessionEndEvent({
        type: "session.status",
        data: { status: { type: "idle" } },
      }),
      true
    );
    assert.equal(
      isSessionEndEvent({
        type: "session.status",
        data: { status: { type: "busy" } },
      }),
      false
    );
    assert.equal(isSessionEndEvent({ type: "session.created" }), false);
  });
});

describe("createTouchLog", () => {
  it("dedupes and keeps insertion order, take clears", () => {
    const log = createTouchLog();
    log.touch("s1", ["b.ts", "a.ts"]);
    log.touch("s1", ["a.ts", "c.ts"]);
    log.touch("s2", ["z.ts"]);
    assert.deepEqual(log.take("s1"), ["b.ts", "a.ts", "c.ts"]);
    assert.deepEqual(log.take("s1"), []);
    assert.deepEqual(log.take("s2"), ["z.ts"]);
    assert.deepEqual(log.take("missing"), []);
  });
});

describe("formatEndSummary", () => {
  it("orders fields by value and caps files at 20 of N", () => {
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const s = formatEndSummary({
      projectName: "p",
      at: "2026-10-02 20:00",
      branch: "main",
      files,
      diff: "3 files changed",
      sessionID: "ses_1",
      commits: ["abc subject"],
    });
    assert.match(s, /^\[p\] opencode session ended 2026-10-02 20:00/);
    assert.match(s, /branch: main/);
    assert.match(s, /files: 20 of 25: f0\.ts/);
    assert.ok(!s.includes("f24.ts"));
    assert.match(s, /uncommitted: 3 files changed/);
    assert.match(s, /session: ses_1/);
    assert.match(s, /recent: abc subject/);
  });

  it("omits empty sections", () => {
    const s = formatEndSummary({
      projectName: "p",
      at: "t",
      branch: "",
      files: [],
      diff: "",
      sessionID: undefined,
      commits: [],
    });
    assert.equal(s, "[p] opencode session ended t");
  });
});

describe("classifySlmError", () => {
  it("tags timeouts, spawn failures, exits, and unknowns", async () => {
    const { classifySlmError } = await import("../src/index.js");
    assert.deepEqual(classifySlmError({ killed: true }, { timeout: 5 }), {
      tag: "timeout",
      timeoutMs: 5,
    });
    assert.deepEqual(classifySlmError({ code: "ENOENT" }), {
      tag: "spawn",
      code: "ENOENT",
    });
    assert.deepEqual(
      classifySlmError({ code: 1, stderr: "  boom  " }),
      { tag: "exit", code: 1, stderr: "boom" }
    );
    assert.deepEqual(classifySlmError(null), { tag: "unknown", code: "", message: "null" });
  });
});

describe("classifySlmError edge cases", () => {
  it("does not mistake a self-signalled child for our timeout", async () => {
    const { classifySlmError } = await import("../src/index.js");
    assert.deepEqual(
      classifySlmError({ code: null, killed: false, signal: "SIGTERM" }),
      { tag: "exit", code: "SIGTERM", stderr: "" }
    );
  });

  it("tags buffer overflow and carries errno details", async () => {
    const { classifySlmError } = await import("../src/index.js");
    assert.deepEqual(
      classifySlmError({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
      { tag: "overflow", limitBytes: 256 * 1024 }
    );
    assert.deepEqual(classifySlmError({ code: "EPERM" }), {
      tag: "spawn",
      code: "EPERM",
    });
  });

  it("unknown carries whatever the runtime said", async () => {
    const { classifySlmError } = await import("../src/index.js");
    const r = classifySlmError({ code: "ERR_OUT_OF_RANGE" });
    assert.equal(r.tag, "unknown");
    assert.equal(r.code, "ERR_OUT_OF_RANGE");
  });
});

describe("createGatewayMonitor", () => {
  it("notifies once at threshold, re-arms on success", async () => {
    const { createGatewayMonitor } = await import("../src/index.js");
    const m = createGatewayMonitor({ threshold: 3 });
    assert.equal(m.failure({ tag: "spawn" }), false);
    assert.equal(m.failure({ tag: "spawn" }), false);
    assert.equal(m.failure({ tag: "timeout" }), true);
    assert.equal(m.failure({ tag: "timeout" }), false);
    m.success();
    assert.equal(m.failure({ tag: "exit" }), false);
    assert.deepEqual(m.status().lastError, { tag: "exit" });
  });
});

describe("runSlmStrict exec adapter", () => {
  it("trims success stdout and passes through file/args/opts", async () => {
    const { runSlmStrict } = await import("../src/index.js");
    let seen;
    const fakeExec = async (file, args, opts) => {
      seen = { file, args, opts };
      return { stdout: "  hello  \n", stderr: "" };
    };
    const r = await runSlmStrict(["session-context", "q"], { timeout: 123, exec: fakeExec });
    assert.deepEqual(r, { ok: true, stdout: "hello" });
    assert.equal(seen.file, process.env.SLM_BIN || "slm");
    assert.deepEqual(seen.args, ["session-context", "q"]);
    assert.deepEqual(seen.opts, { timeout: 123, maxBuffer: 256 * 1024 });
  });

  it("production default shells out for real", async () => {
    const { runSlmStrict } = await import("../src/index.js");
    const prev = process.env.SLM_BIN;
    process.env.SLM_BIN = "/bin/echo";
    try {
      const r = await runSlmStrict(["hello"], { timeout: 5000 });
      assert.deepEqual(r, { ok: true, stdout: "hello" });
    } finally {
      if (prev === undefined) delete process.env.SLM_BIN;
      else process.env.SLM_BIN = prev;
    }
  });

  it("maps timeout rejection to the timeout tag", async () => {
    const { runSlmStrict } = await import("../src/index.js");
    const fakeExec = async () => {
      throw { killed: true };
    };
    const r = await runSlmStrict(["session-context", "q"], { timeout: 5, exec: fakeExec });
    assert.deepEqual(r, { ok: false, error: { tag: "timeout", timeoutMs: 5 } });
  });

  it("maps ENOENT rejection to the spawn tag", async () => {
    const { runSlmStrict } = await import("../src/index.js");
    const fakeExec = async () => {
      throw { code: "ENOENT" };
    };
    const r = await runSlmStrict(["session-context", "q"], { exec: fakeExec });
    assert.deepEqual(r, { ok: false, error: { tag: "spawn", code: "ENOENT" } });
  });

  it("maps non-zero exit with stderr to the exit tag", async () => {
    const { runSlmStrict } = await import("../src/index.js");
    const fakeExec = async () => {
      throw { code: 1, stderr: "  boom  " };
    };
    const r = await runSlmStrict(["session-context", "q"], { exec: fakeExec });
    assert.deepEqual(r, { ok: false, error: { tag: "exit", code: 1, stderr: "boom" } });
  });

  it("maps maxBuffer overflow code to the overflow tag", async () => {
    const { runSlmStrict } = await import("../src/index.js");
    const fakeExec = async () => {
      throw { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" };
    };
    const r = await runSlmStrict(["session-context", "q"], { exec: fakeExec });
    assert.deepEqual(r, {
      ok: false,
      error: { tag: "overflow", limitBytes: 256 * 1024 },
    });
  });
});

describe("createTouchLog.peek", () => {
  it("reads without clearing, take still drains", async () => {
    const { createTouchLog } = await import("../src/index.js");
    const log = createTouchLog();
    log.touch("s1", ["a.ts"]);
    assert.deepEqual(log.peek("s1"), ["a.ts"]);
    assert.deepEqual(log.peek("s1"), ["a.ts"]);
    assert.deepEqual(log.take("s1"), ["a.ts"]);
    assert.deepEqual(log.peek("s1"), []);
    assert.deepEqual(log.peek("missing"), []);
  });
});

describe("endSummaryHash", () => {
  it("is stable for identical payloads, differs on change", async () => {
    const { endSummaryHash } = await import("../src/index.js");
    const a = endSummaryHash({ branch: "main", files: ["x.ts"], diff: "", commits: [] });
    const b = endSummaryHash({ branch: "main", files: ["x.ts"], diff: "", commits: [] });
    const c = endSummaryHash({ branch: "main", files: ["x.ts", "y.ts"], diff: "", commits: [] });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe("createEndSummaryGate", () => {
  it("writes first, then blocks too-soon and unchanged, passes on changed+aged", async () => {
    const { createEndSummaryGate } = await import("../src/index.js");
    const gate = createEndSummaryGate({ minIntervalMs: 15 * 60 * 1000 });
    const h1 = "hash-1";
    const h2 = "hash-2";
    assert.equal(gate.shouldWrite("k", h1, 0), true);
    gate.markWritten("k", h1, 0);
    // Too soon even with changed content.
    assert.equal(gate.shouldWrite("k", h2, 60 * 1000), false);
    // Aged but unchanged.
    assert.equal(gate.shouldWrite("k", h1, 16 * 60 * 1000), false);
    // Aged and changed.
    assert.equal(gate.shouldWrite("k", h2, 16 * 60 * 1000), true);
  });

  it("keys are independent and unknown-safe", async () => {
    const { createEndSummaryGate } = await import("../src/index.js");
    const gate = createEndSummaryGate({ minIntervalMs: 1000 });
    gate.markWritten("a", "h", 0);
    assert.equal(gate.shouldWrite("b", "h", 500), true);
    assert.equal(gate.shouldWrite("", "h", 500), true);
  });

  it("default interval is 15 minutes", async () => {
    const { END_SUMMARY_MIN_INTERVAL_MS } = await import("../src/index.js");
    assert.equal(END_SUMMARY_MIN_INTERVAL_MS, 15 * 60 * 1000);
  });
});

describe("parseEndSummaryMinIntervalMs", () => {
  it("defaults when unset/empty/garbage, honors 0 as disable", async () => {
    const { parseEndSummaryMinIntervalMs } = await import("../src/index.js");
    const dflt = 15 * 60 * 1000;
    assert.equal(parseEndSummaryMinIntervalMs(undefined), dflt);
    assert.equal(parseEndSummaryMinIntervalMs(""), dflt);
    assert.equal(parseEndSummaryMinIntervalMs("abc"), dflt);
    assert.equal(parseEndSummaryMinIntervalMs("-5"), dflt);
    assert.equal(parseEndSummaryMinIntervalMs("0"), 0);
    assert.equal(parseEndSummaryMinIntervalMs("60000"), 60000);
  });
});

describe("createEndSummaryGate with minIntervalMs 0", () => {
  it("disables the interval check but keeps the change gate", async () => {
    const { createEndSummaryGate } = await import("../src/index.js");
    const gate = createEndSummaryGate({ minIntervalMs: 0 });
    gate.markWritten("k", "h1", 1000);
    // Changed content writes immediately (no interval to wait out).
    assert.equal(gate.shouldWrite("k", "h2", 1000), true);
    gate.markWritten("k", "h2", 1000);
    // Identical content still blocked by the change gate.
    assert.equal(gate.shouldWrite("k", "h2", 1000), false);
  });
});
