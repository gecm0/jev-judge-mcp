# jev-plugin

A Claude Code plugin that gives Claude one tool, `judge`, for consulting
[TypeSafe's Jev](https://docs.typesafe.ai/concepts/system-one), plus a skill teaching it when
and how to ask. Ported from the Pi extension `pi-jev`, keeping its request contract, validation
and error handling.

Jev complements the active model; it does not replace it.

## Install

```bash
claude plugin marketplace add ~/Developer/jev-plugin
claude plugin install typesafe@jev
```

Get an API key from [TypeSafe](https://console.typesafe.ai/). Set `TYPESAFE_API_KEY` in the
environment that launches Claude Code, then restart it. Do not paste the key into chat and do not
commit it. This plugin does not load `.env` files.

`TYPESAFE_MODEL` optionally pins a version, for example `jev-1.13.0`. The default, `jev-latest`,
follows TypeSafe's stable alias and can change over time. The response reports the model the API
actually used.

Without a key the tool is still listed, and fails with a clear message before making a request.

## What it contains

| Path | Purpose |
| --- | --- |
| `mcp/server.mjs` | MCP stdio server exposing the `judge` tool |
| `skills/jev/SKILL.md` | How to design a call: decomposition, fan-out, reading probabilities |
| `.mcp.json` | Registers the server when the plugin is enabled |

`pi-jev` shipped its usage guidance as `promptGuidelines`, which MCP has no hook for. That content
is split in two, with each fact in exactly one place: the **tool description** holds what prevents
a wrong action (when to reach for it, and how to misread a result), since it is loaded on every
turn; the **skill** holds question design, and is reached through a pointer at the end of the tool
description. Adding a fact to both is a regression, not redundancy.

## Use

Ask Claude, for example:

> Use Jev to classify this bug report and assess its severity in one call:
> Export crashes in Safari but works in Chrome.

Claude supplies evidence and independent questions:

```json
{
  "state": { "report": "Export crashes in Safari but works in Chrome." },
  "questions": {
    "team": {
      "type": "choice",
      "instructions": "Which team should handle the report?",
      "criteria": {
        "engineering": "Broken functionality",
        "other": "None of the listed teams fits"
      }
    },
    "all_browsers": {
      "type": "noul",
      "instructions": "Does the report say every browser is affected?"
    },
    "severity": {
      "type": "score",
      "instructions": "How severe is the reported defect?",
      "criteria": [
        "Cosmetic; functionality still works",
        "Broken functionality with an available workaround",
        "Blocking defect without an available workaround"
      ]
    }
  }
}
```

- **Choice:** one of 2-255 named options, plus probabilities and confidence.
- **Noul:** probability of yes, from 0 to 1. No separate confidence. Optional `criteria` describes
  the `true` and `false` cases.
- **Score:** a probability-weighted position from 0 to `levels.length - 1`, with 2-10 descriptive
  levels, probabilities, confidence, and a legend.

Instructions and criterion descriptions may also be JSON objects or arrays. Choice descriptions may
be null when the option name is sufficient. Question IDs only identify results; Jev does not see
them during inference. Questions run independently over the same state and cannot use each other's
answers.

## Boundaries

- Every invocation sends the supplied state and questions to
  `https://api.typesafe.ai/v1/systemone` and consumes TypeSafe API usage. It never automatically
  reads files or forwards session history. Only send data allowed by your project's sharing
  policy, never credentials.
- Jev supplies judgments, not research, generated explanations, proof, or permission to execute
  actions. Confidence measures distribution concentration, not truth. It cannot select a candidate
  you omitted. Include a no-match option where needed.
- Jev accepts text/JSON, not images or audio. English is currently its strongest language.
- The server uses native `fetch` with a **30-second** deadline and honours MCP cancellation. Errors
  are explicit, with **no automatic retry** and no fallback model. Wait before retrying rate-limit
  or overload errors. Error bodies are never echoed into the transcript, because they can contain
  submitted evidence.
- TypeSafe documents **64k tokens per request** and **32k for state plus the longest question** for
  Jev 1.13. The service enforces the budget; this server does not approximate it.
- TypeSafe billing is separate from Claude's. Calls and results are retained in normal session
  history.
- Output above **2000 lines or 50 KB** is truncated, with the full response written to a private
  temporary file (mode 0600). That file can contain sensitive evidence echoed back in rubric
  descriptions; remove it when no longer needed.

## Verify

```bash
pnpm install
pnpm test
```

Tests use simulated HTTP responses and need no API key. They cover the advertised JSON Schema,
credential handling, request batching, per-question answer validation, HTTP and network failures,
cancellation, and output truncation. They do not measure Jev's accuracy or prove your account can
reach the live service.

Protocol smoke test, also without a key:

```bash
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node mcp/server.mjs
```

For a live test after configuring the key, ask Claude:

> Call judge with state "The sky is blue" and a noul question asking whether the text mentions a
> colour. Show the probability and the model the API returned.

## Differences from `pi-jev`

- `defineTool` and the Pi `ExtensionAPI` are replaced by an MCP stdio server.
- `promptSnippet` and `promptGuidelines` have no MCP equivalent; their content moved into the tool
  description and the skill.
- Pi's `truncateHead` is replaced by a local head-truncation helper with the same limits.
- The startup warning about a missing key is gone: a plugin MCP server has no UI. The first call
  reports it instead.

## References

[HTTP API](https://docs.typesafe.ai/api) ·
[Question types](https://docs.typesafe.ai/primitives) ·
[Confidence](https://docs.typesafe.ai/confidence)
