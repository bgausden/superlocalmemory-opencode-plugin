import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retrieval } from "../src/index.js";

describe("retrieval.text", () => {
  it("returns the last user message, skipping system/assistant/tool", () => {
    const event = {
      sessionID: "ses_1",
      system: [],
      messages: [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "remember this" }] },
      ],
    };
    assert.equal(retrieval.text(event), "remember this");
  });

  it("skips tool results to reuse the triggering question", () => {
    const event = {
      messages: [
        { role: "user", content: [{ type: "text", text: "question" }] },
        { role: "assistant", content: [{ type: "text", text: "call" }] },
        { role: "tool", content: [{ type: "text", text: "result" }] },
      ],
    };
    assert.equal(retrieval.text(event), "question");
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
    assert.equal(
      retrieval.sessionID({ data: { sessionID: "b" } }),
      "b"
    );
    assert.equal(
      retrieval.sessionID({ sessionID: "", data: { sessionID: "b" } }),
      "b"
    );
    assert.equal(retrieval.sessionID({}), undefined);
  });
});

describe("retrieval.filePaths", () => {
  it("reads path-only edit/write input", () => {
    assert.deepEqual(retrieval.filePaths({ path: "a/b" }), ["a/b"]);
  });

  it("reads multi-file read input", () => {
    assert.deepEqual(retrieval.filePaths({ filePaths: ["a", "b"] }), [
      "a",
      "b",
    ]);
  });

  it("parses patch-embedded targets", () => {
    const patchText = [
      "*** Add File: new/f.ts",
      "+++ content",
      "*** Update File: src/old.ts",
      "+++ content",
    ].join("\n");
    assert.deepEqual(retrieval.filePaths({ patchText }), [
      "new/f.ts",
      "src/old.ts",
    ]);
  });

  it("keeps legacy filePath spelling and dedupes", () => {
    assert.deepEqual(
      retrieval.filePaths({ filePath: "a", path: "a" }),
      ["a"]
    );
  });

  it("returns empty when absent", () => {
    assert.deepEqual(retrieval.filePaths({}), []);
    assert.deepEqual(retrieval.filePaths(null), []);
  });
});

describe("retrieval.filePath", () => {
  it("returns the first touched path", () => {
    assert.equal(retrieval.filePath({ filePaths: ["a", "b"] }), "a");
    assert.equal(retrieval.filePath({}), "");
  });
});
