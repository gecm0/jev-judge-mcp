import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { TOOL_NAME, createServer, parameters, runJev, toolDescription } from "./mcp/server.mjs";

const params = {
  state: { report: "Export crashes in Safari but works in Chrome." },
  questions: {
    team: { type: "choice", instructions: "Which team owns this?", criteria: { engineering: "Broken functionality", other: null } },
    urgent: { type: "noul", instructions: "Is every browser affected?" },
    severity: { type: "score", instructions: "How severe is the defect?", criteria: ["Cosmetic", "Broken with workaround", "Blocking without workaround"] },
  },
};
const fixture = {
  model: "jev-1.13.0",
  answers: {
    team: { type: "choice", choice: "engineering", confidence: 0.8, probabilities: { engineering: 0.9, other: 0.1 } },
    urgent: { type: "noul", noul: 0.05 },
    severity: { type: "score", score: 1.2, confidence: 0.7, probabilities: { 0: 0, 1: 0.8, 2: 0.2 }, legend: { 0: "Cosmetic", 1: "Broken with workaround", 2: "Blocking without workaround" } },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
};

test("Jev MCP tool: schema, request contract, validation, failures, truncation", async (t) => {
  const oldKey = process.env.TYPESAFE_API_KEY;
  const oldModel = process.env.TYPESAFE_MODEL;
  t.after(() => {
    for (const [name, value] of [["TYPESAFE_API_KEY", oldKey], ["TYPESAFE_MODEL", oldModel]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_MODEL;

  // The schema MCP advertises must be a plain JSON Schema object, and the description must carry
  // the guidance that the Pi extension shipped as promptGuidelines.
  assert.equal(parameters.type, "object");
  // The always-loaded description must keep the facts that stop a wrong action, plus the pointer
  // to the skill that holds everything else. Question-design guidance lives there, not here.
  for (const hint of ["choice", "noul", "score", "cannot tell", "never grants permission", "credentials", "TYPESAFE_API_KEY", "jev skill"]) {
    assert.ok(toolDescription.includes(hint), `description keeps "${hint}"`);
  }
  // The agent-visible name is mcp__plugin_typesafe_jev__judge; the verb is the part that matters.
  assert.equal(TOOL_NAME, "judge");
  assert.ok(createServer());

  const fetchMock = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer test-secret");
    assert.deepEqual(JSON.parse(init.body), { ...params, model: "jev-latest" });
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(fixture);
  });

  await assert.rejects(runJev(params), /Set TYPESAFE_API_KEY/);
  assert.equal(fetchMock.mock.callCount(), 0);

  process.env.TYPESAFE_API_KEY = "bad key\n";
  await assert.rejects(runJev(params), /cannot be sent in an HTTP header/);
  assert.equal(fetchMock.mock.callCount(), 0);

  process.env.TYPESAFE_API_KEY = "test-secret";

  // Bad arguments are named precisely, against the variant the `type` field selects.
  await assert.rejects(runJev({ state: "x", questions: { a: { type: "poll", instructions: "?" } } }), /type must be "choice", "noul", or "score"/);
  await assert.rejects(runJev({ state: "x", questions: { a: { type: "score", instructions: "?", criteria: ["only one"] } } }), /question "a" \(score\)/);
  await assert.rejects(runJev({ state: "x", questions: {} }), /at least one typed question/);

  // Happy path: batched questions, answers validated per question type.
  const text = await runJev(params);
  assert.equal(fetchMock.mock.callCount(), 1);
  const result = JSON.parse(text);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.answers.urgent.noul, 0.05);
  assert.equal(result.answers.team.choice, "engineering");
  assert.ok(Number.isInteger(result.elapsed_ms));

  // An answer naming an option that was never offered must not reach the model as a judgment.
  fetchMock.mock.mockImplementationOnce(async () => Response.json({
    ...fixture,
    answers: { ...fixture.answers, team: { ...fixture.answers.team, choice: "marketing" } },
  }));
  await assert.rejects(runJev(params), /invalid or missing answer for "team"/);

  // HTTP errors carry a hint and never echo the response body.
  fetchMock.mock.mockImplementationOnce(async () => new Response("secret evidence", { status: 429 }));
  await assert.rejects(runJev(params), (error) => /TypeSafe HTTP 429/.test(error.message) && /Wait before retrying/.test(error.message) && !/secret evidence/.test(error.message));

  // Network failures must not surface the underlying error: Node embeds the API key in it.
  fetchMock.mock.mockImplementationOnce(async () => { throw new TypeError("Invalid header value: Bearer test-secret"); });
  await assert.rejects(runJev(params), (error) => /Could not reach TypeSafe/.test(error.message) && !/test-secret/.test(error.message));

  // Cancellation wins over the generic unreachable message.
  const aborted = AbortSignal.abort();
  await assert.rejects(runJev(params, aborted), { name: "AbortError" });

  // Oversized output is truncated, with the full payload left in a private file.
  const big = {
    model: "jev-1.13.0",
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: { urgent: { type: "noul", noul: 0.5 }, filler: "x".repeat(60_000) },
  };
  fetchMock.mock.mockImplementationOnce(async () => Response.json(big));
  const truncatedText = await runJev({ state: "x", questions: { urgent: { type: "noul", instructions: "?" } } });
  const path = truncatedText.match(/Full response: (.+)]/)?.[1];
  assert.ok(path, "truncation names the temporary file");
  assert.ok(truncatedText.length < 60_000);
  const full = JSON.parse(await readFile(path, "utf8"));
  assert.equal(full.answers.filler.length, 60_000);
  await rm(dirname(path), { recursive: true, force: true });
});
