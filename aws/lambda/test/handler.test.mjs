import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, MAX_BODY_BYTES } from "../handler.mjs";

const ORIGIN = "https://main.example.amplifyapp.com";
const USER_A = "user-a-sub";
const USER_B = "user-b-sub";
const ID = "123e4567-e89b-42d3-a456-426614174000";

function setup(sendImpl = async () => ({})) {
  const calls = [];
  const logs = [];
  const ddb = {
    send: async cmd => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      return sendImpl(cmd);
    },
  };
  const log = { info: m => logs.push(JSON.parse(m)), error: m => logs.push(JSON.parse(m)) };
  const handler = createHandler({
    ddb,
    log,
    env: { TRANSACTIONS_TABLE: "Tx", BUDGET_TABLE: "Budget", ALLOWED_ORIGIN: ORIGIN },
    now: () => new Date("2026-11-17T10:00:00.000Z"),
    uuid: () => ID,
  });
  return { handler, calls, logs };
}

function event(routeKey, { sub = USER_A, body, pathParameters, queryStringParameters } = {}) {
  const [method] = routeKey.split(" ");
  return {
    routeKey,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    pathParameters,
    queryStringParameters,
    requestContext: {
      requestId: "req-1",
      http: { method, sourceIp: "1.2.3.4" },
      authorizer: sub ? { jwt: { claims: { sub } } } : undefined,
    },
  };
}

const validTxn = { type: "expense", amount: 10, category: "Food", date: "2026-11-01" };

test("refuses to start with wildcard CORS", () => {
  assert.throws(() =>
    createHandler({ ddb: {}, env: { TRANSACTIONS_TABLE: "a", BUDGET_TABLE: "b", ALLOWED_ORIGIN: "*" } })
  );
});

test("every route returns 401 without verified JWT claims", async () => {
  const { handler, calls } = setup();
  for (const rk of ["GET /transactions", "POST /transactions", "DELETE /transactions/{id}", "GET /budget", "PUT /budget"]) {
    const res = await handler(event(rk, { sub: null, body: validTxn, pathParameters: { id: ID } }));
    assert.equal(res.statusCode, 401, rk);
  }
  assert.equal(calls.length, 0);
});

test("CORS header is the exact configured origin", async () => {
  const { handler } = setup(async () => ({ Items: [] }));
  const res = await handler(event("GET /transactions"));
  assert.equal(res.headers["Access-Control-Allow-Origin"], ORIGIN);
});

test("list queries only the caller's partition and hides userId", async () => {
  const { handler, calls } = setup(async () => ({ Items: [{ userId: USER_A, id: ID, amount: 1 }] }));
  const res = await handler(event("GET /transactions"));
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].name, "QueryCommand");
  assert.equal(calls[0].input.ExpressionAttributeValues[":u"], USER_A);
  assert.ok(calls[0].input.Limit <= 100);
  const body = JSON.parse(res.body);
  assert.equal(body.items[0].userId, undefined);
  assert.equal(body.nextCursor, null);
});

test("cursor pointing at another user's partition is rejected", async () => {
  const { handler, calls } = setup();
  const cursor = Buffer.from(JSON.stringify({ userId: USER_B, id: ID })).toString("base64url");
  const res = await handler(event("GET /transactions", { queryStringParameters: { cursor } }));
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("create sets id/createdAt/userId on the server and blocks overwrite", async () => {
  const { handler, calls, logs } = setup();
  const res = await handler(event("POST /transactions", { body: validTxn }));
  assert.equal(res.statusCode, 201);
  const put = calls[0].input;
  assert.equal(put.Item.userId, USER_A);
  assert.equal(put.Item.id, ID);
  assert.equal(put.Item.createdAt, "2026-11-17T10:00:00.000Z");
  assert.equal(put.ConditionExpression, "attribute_not_exists(id)");
  assert.equal(JSON.parse(res.body).userId, undefined);
  const audit = logs.find(l => l.type === "audit");
  assert.equal(audit.action, "transaction.create");
  assert.equal(audit.amount, undefined, "audit log must not contain amounts");
});

test("create rejects invalid / malicious input without writing", async () => {
  const { handler, calls } = setup();
  const bad = [
    { ...validTxn, amount: -5000 },
    { ...validTxn, category: "<img src=x onerror=alert(1)>" },
    { ...validTxn, userId: USER_B },
    { ...validTxn, id: ID },
    "not json",
    "[]",
  ];
  for (const body of bad) {
    const res = await handler(event("POST /transactions", { body }));
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test("oversized body is rejected with 413", async () => {
  const { handler, calls } = setup();
  const res = await handler(event("POST /transactions", { body: "x".repeat(MAX_BODY_BYTES + 1) }));
  assert.equal(res.statusCode, 413);
  assert.equal(calls.length, 0);
});

test("delete is scoped to the caller and 404s on someone else's id", async () => {
  const { handler, calls } = setup(async () => {
    const e = new Error("cond");
    e.name = "ConditionalCheckFailedException";
    throw e;
  });
  const res = await handler(event("DELETE /transactions/{id}", { pathParameters: { id: ID } }));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(calls[0].input.Key, { userId: USER_A, id: ID });
});

test("delete rejects malformed ids", async () => {
  const { handler, calls } = setup();
  const res = await handler(event("DELETE /transactions/{id}", { pathParameters: { id: "../budget" } }));
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("budget is per user", async () => {
  const { handler, calls } = setup(async () => ({}));
  const get = await handler(event("GET /budget"));
  assert.deepEqual(JSON.parse(get.body), { monthlyLimit: 0 });
  assert.deepEqual(calls[0].input.Key, { userId: USER_A });

  const put = await handler(event("PUT /budget", { sub: USER_B, body: { monthlyLimit: 250 } }));
  assert.equal(put.statusCode, 200);
  assert.equal(calls[1].input.Item.userId, USER_B);
});

test("internal errors return a generic message", async () => {
  const { handler } = setup(async () => {
    throw new Error("secret table details");
  });
  const res = await handler(event("GET /budget"));
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body, /secret/);
});

test("unknown routes 404", async () => {
  const { handler } = setup();
  const res = await handler(event("GET /admin"));
  assert.equal(res.statusCode, 404);
});
