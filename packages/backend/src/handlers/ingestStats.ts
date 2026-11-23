import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  PLAYER_SLUG_REGEX,
  calculateDailyScore,
  getTodayIsoDate,
  isValidIsoDate,
  type IngestStatsRequest,
  type IngestStatsResponse,
} from '@activity-racer/shared';
import { getHeader, timingSafeEqualString } from '../lib/auth';
import {
  ddb,
  getTableName,
  keys,
  type DailyStatItem,
  type PlayerProfileItem,
} from '../lib/db';
import { HttpError, handleError, jsonResponse, parseJsonBody } from '../lib/http';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const providedApiKey = getHeader(event, 'x-api-key')?.trim() ?? '';
    if (!providedApiKey) {
      throw new HttpError(401, 'Missing x-api-key header.');
    }

    const body = parseJsonBody<IngestStatsRequest>(event);

    if (typeof body.playerSlug !== 'string') {
      throw new HttpError(400, 'playerSlug is required.');
    }
    const playerSlug = body.playerSlug.trim().toLowerCase();
    if (!PLAYER_SLUG_REGEX.test(playerSlug)) {
      throw new HttpError(400, 'Invalid playerSlug format.');
    }

    const date = body.date !== undefined ? String(body.date).trim() : getTodayIsoDate();
    if (!isValidIsoDate(date)) {
      throw new HttpError(400, 'date must be a valid YYYY-MM-DD calendar date.');
    }

    const steps = Number(body.steps);
    if (!Number.isFinite(steps) || steps < 0 || steps > 500000) {
      throw new HttpError(400, 'steps must be a finite number between 0 and 500000.');
    }

    const activeCalories = Number(body.activeCalories);
    if (!Number.isFinite(activeCalories) || activeCalories < 0 || activeCalories > 50000) {
      throw new HttpError(400, 'activeCalories must be a finite number between 0 and 50000.');
    }

    const source =
      typeof body.source === 'string' && body.source.trim().length > 0
        ? body.source.trim().slice(0, 64)
        : 'home-assistant';

    const tableName = getTableName();
    const lookup = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :slugPk',
        ExpressionAttributeValues: {
          ':slugPk': keys.slugGsiPk(playerSlug),
        },
        Limit: 1,
      }),
    );

    const profile = lookup.Items?.[0] as PlayerProfileItem | undefined;
    // Uniform 401 prevents slug enumeration by unauthenticated callers
    if (
      !profile ||
      typeof profile.webhookApiKey !== 'string' ||
      !timingSafeEqualString(providedApiKey, profile.webhookApiKey)
    ) {
      throw new HttpError(401, 'Invalid API key or playerSlug.');
    }

    const roundedSteps = Math.round(steps);
    const roundedCalories = Math.round(activeCalories * 10) / 10;
    const now = new Date().toISOString();

    const statItem: DailyStatItem = {
      PK: keys.userPk(profile.userId),
      SK: keys.statSk(date),
      entityType: 'DAILY_STAT',
      userId: profile.userId,
      date,
      steps: roundedSteps,
      activeCalories: roundedCalories,
      updatedAt: now,
      source,
    };

    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: statItem,
      }),
    );

    const dailyScore = calculateDailyScore(date, roundedSteps, roundedCalories, {
      dailyStepTarget: profile.dailyStepTarget,
      dailyCalorieTarget: profile.dailyCalorieTarget,
      stepWeight: profile.stepWeight,
      calorieWeight: profile.calorieWeight,
    });

    const response: IngestStatsResponse = {
      playerSlug,
      stat: {
        date,
        steps: roundedSteps,
        activeCalories: roundedCalories,
        updatedAt: now,
        source,
      },
      dailyScore,
    };

    return jsonResponse(200, response);
  } catch (err) {
    return handleError(err);
  }
};
