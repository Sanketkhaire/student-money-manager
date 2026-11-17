// Request handling for the Student Money Manager API.
// Security properties (see checklist.md):
//  §1  Every request must carry a Cognito JWT (verified by the API Gateway authorizer).
//      The caller's userId is taken ONLY from the verified token, never from the request.
//      All data is partitioned by userId, so users can't see or change each other's records.
//  §4  Bodies are size-limited and validated against an allowlist; id/createdAt are set here.
//  §5  Listing uses a paginated Query on the caller's partition (no table Scan).
//  §6  CORS is restricted to one configured origin.
//  §8  State changes write a structured audit log (no amounts/descriptions).

import { randomUUID } from "node:crypto";
import { QueryCommand, PutCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { validateTransaction, validateBudget, isPlainObject, isValidId } from "./validation.mjs";

export const MAX_BODY_BYTES = 4096;
export const PAGE_LIMIT = 100;

export function createHandler({ ddb, env = process.env, log = console, now = () => new Date(), uuid = randomUUID }) {
  const TX_TABLE = env.TRANSACTIONS_TABLE;
  const BUDGET_TABLE = env.BUDGET_TABLE;
  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN;
  if (!TX_TABLE || !BUDGET_TABLE || !ALLOWED_ORIGIN) {
    throw new Error("TRANSACTIONS_TABLE, BUDGET_TABLE and ALLOWED_ORIGIN must be set.");
  }
  if (ALLOWED_ORIGIN === "*") throw new Error("ALLOWED_ORIGIN must be an exact origin, not '*'.");

  const HEADERS = Object.freeze({
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    Vary: "Origin",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  const respond = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

  function audit(ctx, action, fields = {}) {
    log.info(JSON.stringify({
      type: "audit",
      action,
      userId: ctx.userId,
      requestId: ctx.requestId,
      sourceIp: ctx.sourceIp,
      ts: now().toISOString(),
      ...fields,
    }));
  }

  function parseBody(event) {
    let raw = event.body ?? "";
    if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return { status: 413, message: "Request body too large." };
    try {
      const value = JSON.parse(raw || "null");
      if (!isPlainObject(value)) return { status: 400, message: "Body must be a JSON object." };
      return { value };
    } catch {
      return { status: 400, message: "Body must be valid JSON." };
    }
  }

  function encodeCursor(key) {
    return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : null;
  }

  function decodeCursor(cursor, userId) {
    if (cursor === undefined) return { key: undefined };
    try {
      const key = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
      const keys = isPlainObject(key) ? Object.keys(key).sort().join(",") : "";
      // A cursor must point inside the caller's own partition.
      if (keys !== "id,userId" || key.userId !== userId || !isValidId(key.id)) return { error: true };
      return { key };
    } catch {
      return { error: true };
    }
  }

  const toPublicTxn = ({ userId, ...rest }) => rest;

  async function listTransactions(ctx, event) {
    const { key, error } = decodeCursor(event.queryStringParameters?.cursor, ctx.userId);
    if (error) return respond(400, { message: "Invalid cursor." });
    const data = await ddb.send(new QueryCommand({
      TableName: TX_TABLE,
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": ctx.userId },
      Limit: PAGE_LIMIT,
      ExclusiveStartKey: key,
    }));
    return respond(200, {
      items: (data.Items || []).map(toPublicTxn),
      nextCursor: encodeCursor(data.LastEvaluatedKey),
    });
  }

  async function createTransaction(ctx, event) {
    const parsed = parseBody(event);
    if (!parsed.value) return respond(parsed.status, { message: parsed.message });
    const result = validateTransaction(parsed.value);
    if (!result.ok) return respond(400, { message: "Invalid transaction.", errors: result.errors });

    const item = { ...result.value, id: uuid(), createdAt: now().toISOString(), userId: ctx.userId };
    await ddb.send(new PutCommand({
      TableName: TX_TABLE,
      Item: item,
      ConditionExpression: "attribute_not_exists(id)",
    }));
    audit(ctx, "transaction.create", { id: item.id });
    return respond(201, toPublicTxn(item));
  }

  async function deleteTransaction(ctx, event) {
    const id = event.pathParameters?.id;
    if (!isValidId(id)) return respond(400, { message: "Invalid transaction id." });
    try {
      await ddb.send(new DeleteCommand({
        TableName: TX_TABLE,
        Key: { userId: ctx.userId, id },
        ConditionExpression: "attribute_exists(id)",
      }));
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") return respond(404, { message: "Not found." });
      throw err;
    }
    audit(ctx, "transaction.delete", { id });
    return respond(200, { id });
  }

  async function getBudget(ctx) {
    const data = await ddb.send(new GetCommand({ TableName: BUDGET_TABLE, Key: { userId: ctx.userId } }));
    return respond(200, { monthlyLimit: data.Item?.monthlyLimit ?? 0 });
  }

  async function putBudget(ctx, event) {
    const parsed = parseBody(event);
    if (!parsed.value) return respond(parsed.status, { message: parsed.message });
    const result = validateBudget(parsed.value);
    if (!result.ok) return respond(400, { message: "Invalid budget.", errors: result.errors });

    await ddb.send(new PutCommand({
      TableName: BUDGET_TABLE,
      Item: { userId: ctx.userId, monthlyLimit: result.value.monthlyLimit, updatedAt: now().toISOString() },
    }));
    audit(ctx, "budget.update");
    return respond(200, result.value);
  }

  const ROUTES = {
    "GET /transactions": listTransactions,
    "POST /transactions": createTransaction,
    "DELETE /transactions/{id}": deleteTransaction,
    "GET /budget": getBudget,
    "PUT /budget": putBudget,
  };

  return async function handler(event) {
    const requestId = event?.requestContext?.requestId;

    if (event?.requestContext?.http?.method === "OPTIONS") {
      return { statusCode: 204, headers: HEADERS, body: "" };
    }

    // Defence in depth: API Gateway's JWT authorizer must have verified the token.
    const userId = event?.requestContext?.authorizer?.jwt?.claims?.sub;
    if (typeof userId !== "string" || userId.length === 0) {
      return respond(401, { message: "Unauthorized." });
    }

    const route = ROUTES[event?.routeKey];
    if (!route) return respond(404, { message: "Not found." });

    const ctx = { userId, requestId, sourceIp: event?.requestContext?.http?.sourceIp };
    try {
      return await route(ctx, event);
    } catch (err) {
      // Details stay in the server logs; the client gets a generic message.
      log.error(JSON.stringify({ type: "error", requestId, route: event.routeKey, name: err?.name, message: err?.message }));
      return respond(500, { message: "Server error." });
    }
  };
}
