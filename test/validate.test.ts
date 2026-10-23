import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize } from "../src/utils/canonicalize.js";
import { validateEvent } from "../src/utils/validate.js";
import { upsert } from "./helpers.js";

test("canonical JSON ignores object key order and keeps array order", () => {
  const left = canonicalize({ b: 1, a: { d: 2, c: [1, 2] } });
  const right = canonicalize({ a: { c: [1, 2], d: 2 }, b: 1 });
  assert.equal(left, right);
  assert.notEqual(
    canonicalize({ skills: ["a", "b"] }),
    canonicalize({ skills: ["b", "a"] }),
  );
});

test("normalization trims display fields and deduplicates skills in first-seen order", () => {
  const result = validateEvent(
    upsert({
      payload: {
        title: "  Full Stack Developer ",
        company: " Example Labs ",
        location: " Surat ",
        skills: [" TypeScript ", "MongoDB", "typescript", "B", "b"],
      },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok || result.event.operation !== "upsert") return;
  assert.equal(result.event.payload.title, "Full Stack Developer");
  assert.equal(result.event.payload.company, "Example Labs");
  assert.equal(result.event.payload.location, "Surat");
  assert.deepEqual(result.event.payload.skills, ["typescript", "mongodb", "b"]);
});

test("validation rejects identifiers, versions, urls, experience, and archive payloads", () => {
  const cases: Array<{ body: unknown; detail: string }> = [
    { body: upsert({ eventId: " evt " }), detail: "surrounding whitespace" },
    { body: upsert({ tenantId: "" }), detail: "tenantId" },
    { body: upsert({ version: 0 }), detail: "version" },
    { body: upsert({ version: 1.5 }), detail: "version" },
    { body: upsert({ version: "1" }), detail: "version" },
    { body: upsert({ operation: "delete" }), detail: "operation" },
    {
      body: upsert({ payload: { applyUrl: "http://example.test/jobs/job-1" } }),
      detail: "https",
    },
    {
      body: upsert({ payload: { experienceMin: 4, experienceMax: 3 } }),
      detail: "experienceMin",
    },
    {
      body: upsert({ payload: { experienceMax: 51 } }),
      detail: "experienceMax",
    },
    { body: upsert({ payload: { title: "   " } }), detail: "title" },
    { body: upsert({ payload: { skills: ["ok", "  "] } }), detail: "skills" },
    {
      body: {
        tenantId: "tenant-a",
        sourceId: "main",
        eventId: "evt-arch",
        externalJobId: "job-1",
        version: 2,
        operation: "archive",
        payload: { title: "nope" },
      },
      detail: "omit payload",
    },
  ];
  for (const entry of cases) {
    const result = validateEvent(entry.body);
    assert.equal(result.ok, false, JSON.stringify(entry.body));
    if (result.ok) continue;
    assert.equal(
      result.errors.some((error: string) => error.includes(entry.detail)),
      true,
      result.errors.join("; "),
    );
  }
});

test("a valid archive omits payload", () => {
  const result = validateEvent({
    tenantId: "tenant-a",
    sourceId: "main",
    eventId: "evt-arch",
    externalJobId: "job-1",
    version: 2,
    operation: "archive",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.event.operation, "archive");
});
