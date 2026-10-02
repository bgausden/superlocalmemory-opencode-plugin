# superlocalmemory-opencode-plugin

OpenCode V2 plugin for SuperLocalMemory V4. No bundled SLM — all memory
access shells out to the system `slm` binary on `PATH`. Fail-open: any
error returns silently so OpenCode never breaks if SLM is down.

Source of truth for the currently loaded copy:
`~/.config/opencode/plugins/slm-memory.js` (id `slm-memory`).

## Install

```sh
npm install
```

Local path plugin in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///Users/barryg/Git/superlocalmemory-opencode-plugin"]
}
```

Or copy `src/index.js` to `~/.config/opencode/plugins/slm-memory.js`.

Requires `@opencode/plugin 2.0.22` (see `package.json`) and `slm` on
`PATH` (`SLM_BIN` overrides the binary name).

## Behaviour

- `session.context` hook: keyword nudge + `slm session-context` + first-message init hint into `event.system` (model-only background, not echoed as user text).
- `tool.execute.after` hook: touch bookkeeping only — accumulates project-relative paths per session, zero subprocesses.
- `session.compaction` hook: inject SLM project knowledge into compaction.
- `event.subscribe`: one enriched per-turn summary (`slm remember`, tag `opencode-session-stop`) on `session.execution.succeeded/failed/interrupted` — timestamp, branch, touched files (20 of N), diff-stat, recent commits. `session.idle/status/compacted` kept as fallback.
