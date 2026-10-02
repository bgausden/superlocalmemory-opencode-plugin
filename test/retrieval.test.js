import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retrieval } from "../src/index.js";

describe("retrieval.text", () => {
  it("returns the last user message, skipping system and assistant", () => {
    const event = {
      messages: [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "remember this" }] },
      ],
    };
    assert.equal(retrieval.text(event), "remember this");
  });

  it("handles string content", () => {
    assert.equal(
      retrieval.text({ messages: [{ role: "user", content: "hi" }] }),
      "hi"
    );
  });

  it("falls back to direct text payloads", () => {
    assert.equal(retrieval.text({ prompt: { text: "  hey  " } }), "hey");
    assert.equal(retrieval.text({ text: "yo" }), "yo");
  });

  it("ignores deleted V1 envelope shapes", () => {
    assert.equal(retrieval.text({ properties: { text: "old" } }), "");
    assert.equal(retrieval.text({}), "");
    assert.equal(retrieval.text(null), "");
  });
});

describe("retrieval.sessionID", () => {
  it("prefers direct sessionID", () => {
    assert.equal(retrieval.sessionID({ sessionID: "a" }), "a");
    assert.equal(retrieval.sessionID({ data: { sessionID: "b" } }), "b");
    assert.equal(retrieval.sessionID({}), undefined);
  });
});

describe("retrieval.filePath", () => {
  it("reads direct args", () => {
    assert.equal(retrieval.filePath({ filePath: "a/b" }), "a/b");
    assert.equal(retrieval.filePath({ path: "c" }), "c");
    assert.equal(retrieval.filePath({ args: { filePath: "d" } }), "d");
    assert.equal(
      retrieval.filePath({ tool_input: { file_path: "e" } }),
      "e"
    );
  });

  it("returns empty when absent", () => {
    assert.equal(retrieval.filePath({}), "");
    assert.equal(retrieval.filePath(null), "");
  });
});
