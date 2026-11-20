import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { HealthResponse } from '@activity-racer/shared';

export const handler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const payload: HealthResponse = {
    status: 'ok',
    service: 'activity-racer-api',
    region: process.env.AWS_REGION ?? 'unknown',
    timestamp: new Date().toISOString(),
  };

  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  };
};
