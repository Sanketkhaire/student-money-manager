import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  DeleteCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TRANSACTIONS_TABLE = "SMM_Transactions";
const BUDGET_TABLE = "SMM_Budget";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,PUT,OPTIONS",
  "Content-Type": "application/json",
};

function respond(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const path = event.rawPath;

  try {
    if (method === "OPTIONS") {
      return respond(200, {});
    }

    if (method === "GET" && path === "/transactions") {
      const data = await ddb.send(new ScanCommand({ TableName: TRANSACTIONS_TABLE }));
      return respond(200, data.Items || []);
    }

    if (method === "POST" && path === "/transactions") {
      const body = JSON.parse(event.body || "{}");
      if (!body.id || !body.type || !body.amount || !body.category || !body.date) {
        return respond(400, { message: "Missing required transaction fields." });
      }
      await ddb.send(new PutCommand({ TableName: TRANSACTIONS_TABLE, Item: body }));
      return respond(200, body);
    }

    if (method === "DELETE" && path.startsWith("/transactions/")) {
      const id = decodeURIComponent(event.pathParameters?.id || "");
      if (!id) return respond(400, { message: "Missing transaction id." });
      await ddb.send(new DeleteCommand({ TableName: TRANSACTIONS_TABLE, Key: { id } }));
      return respond(200, { id });
    }

    if (method === "GET" && path === "/budget") {
      const data = await ddb.send(new GetCommand({ TableName: BUDGET_TABLE, Key: { id: "budget" } }));
      return respond(200, data.Item || { id: "budget", monthlyLimit: 0 });
    }

    if (method === "PUT" && path === "/budget") {
      const body = JSON.parse(event.body || "{}");
      const limit = Number(body.monthlyLimit);
      if (Number.isNaN(limit) || limit < 0) {
        return respond(400, { message: "monthlyLimit must be a number >= 0." });
      }
      const item = { id: "budget", monthlyLimit: limit };
      await ddb.send(new PutCommand({ TableName: BUDGET_TABLE, Item: item }));
      return respond(200, item);
    }

    return respond(404, { message: "Not found" });
  } catch (err) {
    console.error(err);
    return respond(500, { message: "Server error" });
  }
};
