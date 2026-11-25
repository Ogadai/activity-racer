import { PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  HEX_COLOR_REGEX,
  PLAYER_SLUG_REGEX,
  validateScoringTargets,
  type UpdatePlayerProfileRequest,
} from '@activity-racer/shared';
import { generateWebhookApiKey, getAuthClaims } from '../lib/auth';
import {
  ddb,
  ensurePlayerProfile,
  getTableName,
  keys,
  toPlayerProfile,
  type PlayerProfileItem,
} from '../lib/db';
import { HttpError, handleError, jsonResponse, parseJsonBody } from '../lib/http';

async function handleGetMe(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const { userId, email, name } = getAuthClaims(event);
  const profileItem = await ensurePlayerProfile(userId, email, name);
  return jsonResponse(200, toPlayerProfile(profileItem));
}

async function handlePutMe(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const { userId, email, name } = getAuthClaims(event);
  const current = await ensurePlayerProfile(userId, email, name);
  const body = parseJsonBody<UpdatePlayerProfileRequest>(event);

  let displayName = current.displayName;
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== 'string') {
      throw new HttpError(400, 'displayName must be a string.');
    }
    const trimmed = body.displayName.trim();
    if (trimmed.length < 1 || trimmed.length > 40) {
      throw new HttpError(400, 'displayName must be between 1 and 40 characters.');
    }
    displayName = trimmed;
  }

  let playerSlug = current.playerSlug;
  if (body.playerSlug !== undefined) {
    if (typeof body.playerSlug !== 'string') {
      throw new HttpError(400, 'playerSlug must be a string.');
    }
    const normalized = body.playerSlug.trim().toLowerCase();
    if (!PLAYER_SLUG_REGEX.test(normalized)) {
      throw new HttpError(
        400,
        'playerSlug must be 2–32 lowercase letters, numbers, or hyphens and start with a letter or number.',
      );
    }
    playerSlug = normalized;
  }

  let bikeColor = current.bikeColor;
  if (body.bikeColor !== undefined) {
    if (typeof body.bikeColor !== 'string' || !HEX_COLOR_REGEX.test(body.bikeColor.trim())) {
      throw new HttpError(400, 'bikeColor must be a valid 6-digit hex color (e.g. #2563eb).');
    }
    bikeColor = body.bikeColor.trim().toLowerCase();
  }

  const nextTargets = {
    dailyStepTarget:
      body.dailyStepTarget !== undefined ? Number(body.dailyStepTarget) : current.dailyStepTarget,
    dailyCalorieTarget:
      body.dailyCalorieTarget !== undefined
        ? Number(body.dailyCalorieTarget)
        : current.dailyCalorieTarget,
    stepWeight: body.stepWeight !== undefined ? Number(body.stepWeight) : current.stepWeight,
    calorieWeight:
      body.calorieWeight !== undefined ? Number(body.calorieWeight) : current.calorieWeight,
  };

  const targetError = validateScoringTargets(nextTargets);
  if (targetError) {
    throw new HttpError(400, targetError);
  }

  const webhookApiKey =
    body.rotateWebhookApiKey === true ? generateWebhookApiKey() : current.webhookApiKey;
  const now = new Date().toISOString();

  const updatedItem: PlayerProfileItem = {
    ...current,
    GSI1PK: keys.slugGsiPk(playerSlug),
    GSI1SK: keys.userPk(userId),
    displayName,
    playerSlug,
    bikeColor,
    dailyStepTarget: Math.round(nextTargets.dailyStepTarget),
    dailyCalorieTarget: Math.round(nextTargets.dailyCalorieTarget),
    stepWeight: nextTargets.stepWeight,
    calorieWeight: nextTargets.calorieWeight,
    webhookApiKey,
    updatedAt: now,
  };

  const tableName = getTableName();
  const slugChanged = playerSlug !== current.playerSlug;

  if (slugChanged) {
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  PK: keys.slugLockPk(playerSlug),
                  SK: keys.uniqueSk(),
                  entityType: 'SLUG_LOCK',
                  userId,
                  createdAt: now,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: {
                  PK: keys.slugLockPk(current.playerSlug),
                  SK: keys.uniqueSk(),
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: updatedItem,
              },
            },
          ],
        }),
      );
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'TransactionCanceledException') {
        throw new HttpError(409, `playerSlug '${playerSlug}' is already in use.`);
      }
      throw err;
    }
  } else {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: updatedItem,
      }),
    );
  }

  return jsonResponse(200, toPlayerProfile(updatedItem));
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const method = event.requestContext.http.method.toUpperCase();
    if (method === 'GET') {
      return await handleGetMe(event);
    }
    if (method === 'PUT') {
      return await handlePutMe(event);
    }
    throw new HttpError(405, `Method ${method} not allowed.`);
  } catch (err) {
    return handleError(err);
  }
};
