// Lambda entry point. Wiring only — the logic lives in handler.mjs so it can be tested.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createHandler } from "./handler.mjs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = createHandler({ ddb });
