import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retrieval, patchPaths, isSessionEndEvent } from "../src/index.js";

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
    assert.equal(isSessionEndEvent({ type: "session.idle" }), true);
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
