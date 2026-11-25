import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getTodayIsoDate, type RaceRange } from '@activity-racer/shared';
import { getAuthClaims } from '../lib/auth';
import { HttpError, handleError, jsonResponse } from '../lib/http';
import { loadGroupRaceData } from '../lib/raceLoader';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const { userId } = getAuthClaims(event);
    const groupId = event.pathParameters?.groupId?.trim();
    if (!groupId) {
      throw new HttpError(400, 'groupId path parameter is required.');
    }

    const rawRange = (event.queryStringParameters?.range ?? 'daily').trim().toLowerCase();
    if (rawRange !== 'daily' && rawRange !== 'weekly') {
      throw new HttpError(400, "range query parameter must be 'daily' or 'weekly'.");
    }
    const range: RaceRange = rawRange;

    const anchorDate = event.queryStringParameters?.date?.trim() || getTodayIsoDate();

    const response = await loadGroupRaceData({
      callerUserId: userId,
      groupId,
      range,
      anchorDate,
    });

    return jsonResponse(200, response);
  } catch (err) {
    return handleError(err);
  }
};
