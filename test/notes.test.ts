import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { MAX_NOTE_LENGTH, type Session } from "../src/notes.js";

const sessions: Record<string, Session> = {
  a: { userId: "user-a", csrfToken: "csrf-a" },
  b: { userId: "user-b", csrfToken: "csrf-b" },
};
const events: Record<string, string>[] = [];

function build() {
  events.length = 0;
  return createApp({
    sessions: (req) => sessions[req.get("x-test-session") ?? ""],
    allowedOrigins: ["https://app.example"],
    log: (e) => events.push(e),
  });
}

const as = (who: "a" | "b") => ({ "x-test-session": who, "x-csrf-token": sessions[who].csrfToken });

test("notes endpoints require a session (R1)", async () => {
  const app = build();
  const id = "11111111-1111-4111-8111-111111111111";
  const calls = [
    request(app).get("/api/notes"),
    request(app).post("/api/notes").send({ text: "x" }),
    request(app).get(`/api/notes/${id}`),
    request(app).put(`/api/notes/${id}`).send({ text: "x" }),
    request(app).delete(`/api/notes/${id}`),
  ];
  for (const res of await Promise.all(calls)) {
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "unauthorized" });
  }
  assert.ok(events.some((e) => e.event === "auth_failure"));
});

test("owner comes from the session and responses are safe (R2, R7, TM-009)", async () => {
  const app = build();
  const res = await request(app)
    .post("/api/notes")
    .set(as("a"))
    .send({ text: "<script>alert(1)</script>", owner_id: "user-b", ownerId: "user-b" });
  assert.equal(res.status, 201);
  assert.match(res.headers["content-type"], /application\/json/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body.ownerId, undefined);
  assert.equal(res.body.owner_id, undefined);
  const listB = await request(app).get("/api/notes").set(as("b"));
  assert.deepEqual(listB.body.notes, []);
  const listA = await request(app).get("/api/notes").set(as("a"));
  assert.equal(listA.body.notes.length, 1);
});

test("cross-user read, update and delete are 404 and logged without text (R3, R4, R5, R10)", async () => {
  const app = build();
  const created = await request(app).post("/api/notes").set(as("a")).send({ text: "secret-text" });
  const id = created.body.id as string;

  assert.equal((await request(app).get(`/api/notes/${id}`).set(as("b"))).status, 404);
  assert.equal((await request(app).put(`/api/notes/${id}`).set(as("b")).send({ text: "pwned" })).status, 404);
  assert.equal((await request(app).delete(`/api/notes/${id}`).set(as("b"))).status, 404);

  const still = await request(app).get(`/api/notes/${id}`).set(as("a"));
  assert.equal(still.status, 200);
  assert.equal(still.body.text, "secret-text");

  const denied = events.filter((e) => e.event === "note_access_denied");
  assert.equal(denied.length, 3);
  assert.equal(denied[0].userId, "user-b");
  assert.equal(denied[0].noteId, id);
  assert.ok(!JSON.stringify(events).includes("secret-text"));
  assert.ok(!JSON.stringify(events).includes("pwned"));
});

test("owner can update and delete (hard delete)", async () => {
  const app = build();
  const id = (await request(app).post("/api/notes").set(as("a")).send({ text: "one" })).body.id as string;
  const upd = await request(app).put(`/api/notes/${id}`).set(as("a")).send({ text: "two", owner_id: "user-b" });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.text, "two");
  assert.equal((await request(app).delete(`/api/notes/${id}`).set(as("a"))).status, 204);
  assert.equal((await request(app).get(`/api/notes/${id}`).set(as("a"))).status, 404);
});

test("invalid text is rejected and nothing is stored (R6)", async () => {
  const app = build();
  const bodies: unknown[] = [
    {},
    { text: "" },
    { text: "   " },
    { text: 5 },
    { text: ["a"] },
    { text: "x".repeat(MAX_NOTE_LENGTH + 1) },
    [],
    "text",
  ];
  for (const body of bodies) {
    const res = await request(app).post("/api/notes").set(as("a")).send(body as object);
    assert.equal(res.status, 400, JSON.stringify(body)?.slice(0, 40));
  }
  const list = await request(app).get("/api/notes").set(as("a"));
  assert.deepEqual(list.body.notes, []);
});

test("SQL metacharacters in text and id are inert (R8, R11)", async () => {
  const app = build();
  const text = "'; DROP TABLE notes; --";
  const res = await request(app).post("/api/notes").set(as("a")).send({ text });
  assert.equal(res.status, 201);
  assert.equal(res.body.text, text);
  for (const id of ["' OR '1'='1", "1", "../x", "11111111-1111-4111-8111-111111111111"]) {
    const r = await request(app).get(`/api/notes/${encodeURIComponent(id)}`).set(as("b"));
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: "not found" });
  }
});

test("state-changing requests need the CSRF token and a trusted origin (R9)", async () => {
  const app = build();
  const noToken = await request(app).post("/api/notes").set("x-test-session", "a").send({ text: "x" });
  assert.equal(noToken.status, 403);
  const wrongToken = await request(app)
    .post("/api/notes")
    .set({ "x-test-session": "a", "x-csrf-token": "csrf-b" })
    .send({ text: "x" });
  assert.equal(wrongToken.status, 403);
  const badOrigin = await request(app)
    .post("/api/notes")
    .set(as("a"))
    .set("origin", "https://evil.example")
    .send({ text: "x" });
  assert.equal(badOrigin.status, 403);
  const goodOrigin = await request(app)
    .post("/api/notes")
    .set(as("a"))
    .set("origin", "https://app.example")
    .send({ text: "x" });
  assert.equal(goodOrigin.status, 201);
  const list = await request(app).get("/api/notes").set(as("a"));
  assert.equal(list.body.notes.length, 1);
});

test("list is paginated and validates paging input", async () => {
  const app = build();
  for (let i = 0; i < 3; i++) {
    await request(app).post("/api/notes").set(as("a")).send({ text: `n${i}` });
  }
  const page = await request(app).get("/api/notes?limit=2&offset=0").set(as("a"));
  assert.equal(page.body.notes.length, 2);
  assert.equal((await request(app).get("/api/notes?limit=1000").set(as("a"))).status, 400);
  assert.equal((await request(app).get("/api/notes?limit=abc").set(as("a"))).status, 400);
});

test("malformed JSON gives a generic error", async () => {
  const app = build();
  const res = await request(app)
    .post("/api/notes")
    .set(as("a"))
    .set("content-type", "application/json")
    .send("{bad");
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: "bad request" });
});
