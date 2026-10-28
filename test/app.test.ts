import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp();

test("GET /health returns ok", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok" });
});

test("GET /api/greeting greets a valid name", async () => {
  const res = await request(app).get("/api/greeting").query({ name: "Ada" });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/json/);
  assert.deepEqual(res.body, { message: "Hello, Ada!" });
});

test("GET /api/greeting rejects invalid names", async () => {
  const invalid = ["", "Ada1", "<script>", "a".repeat(41), "Ada Lovelace"];
  for (const name of invalid) {
    const res = await request(app).get("/api/greeting").query({ name });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(name)}`);
  }
  assert.equal((await request(app).get("/api/greeting")).status, 400);
  assert.equal((await request(app).get("/api/greeting?name=Ada&name=Bob")).status, 400);
});

test("responses carry security headers and no cookies", async () => {
  const res = await request(app).get("/health");
  assert.ok(res.headers["content-security-policy"]);
  assert.ok(res.headers["strict-transport-security"]);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(res.headers["x-powered-by"], undefined);
  assert.equal(res.headers["set-cookie"], undefined);
});

test("unknown routes return a JSON 404", async () => {
  const res = await request(app).get("/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "not found" });
});

test("oversized JSON bodies are rejected without detail", async () => {
  const res = await request(app)
    .post("/health")
    .set("content-type", "application/json")
    .send(JSON.stringify({ pad: "x".repeat(20_000) }));
  assert.equal(res.status, 413);
  assert.deepEqual(res.body, { error: "bad request" });
});
