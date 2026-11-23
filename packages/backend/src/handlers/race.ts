import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  BIKE_COLOR_PALETTE,
  DEFAULT_CALORIE_WEIGHT,
  DEFAULT_DAILY_CALORIE_TARGET,
  DEFAULT_DAILY_STEP_TARGET,
  DEFAULT_STEP_WEIGHT,
  calculateDailyScore,
  calculateWeeklyScore,
  getDateWindow,
  getTodayIsoDate,
  isValidIsoDate,
  rankRaceStandings,
  type RaceRange,
  type RaceResponse,
  type UnrankedRaceStanding,
} from '@activity-racer/shared';
import { getAuthClaims } from '../lib/auth';
import {
  batchGetItems,
  ddb,
  getTableName,
  keys,
  type DailyStatItem,
  type GroupMembershipItem,
  type GroupMetaItem,
  type PlayerProfileItem,
} from '../lib/db';
import { HttpError, handleError, jsonResponse } from '../lib/http';

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
    if (!isValidIsoDate(anchorDate)) {
      throw new HttpError(400, 'date query parameter must be a valid YYYY-MM-DD calendar date.');
    }

    const tableName = getTableName();

    // Verify group exists and caller is a member
    const [groupMetaRes, callerMembershipRes] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: keys.groupPk(groupId),
            SK: keys.groupMetaSk(),
          },
        }),
      ),
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            PK: keys.groupPk(groupId),
            SK: keys.memberSk(userId),
          },
        }),
      ),
    ]);

    const groupMeta = groupMetaRes.Item as GroupMetaItem | undefined;
    if (!groupMeta) {
      throw new HttpError(404, 'Group not found.');
    }
    if (!callerMembershipRes.Item) {
      throw new HttpError(403, 'You are not a member of this group.');
    }

    // Fetch all group members
    const membersRes = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :groupPk AND begins_with(SK, :memberPrefix)',
        ExpressionAttributeValues: {
          ':groupPk': keys.groupPk(groupId),
          ':memberPrefix': 'MEMBER#',
        },
      }),
    );

    const memberships = (membersRes.Items as GroupMembershipItem[] | undefined) ?? [];
    const memberIds = memberships.map((m) => m.userId);

    // Fetch all member profiles in a single batched round-trip
    const profileItems = await batchGetItems<PlayerProfileItem>(
      memberIds.map((id) => ({
        PK: keys.userPk(id),
        SK: keys.profileSk(),
      })),
    );
    const profileByUserId = new Map(profileItems.map((p) => [p.userId, p]));

    const window = getDateWindow(range, anchorDate);

    // Fetch stats for all members for the requested window
    const statsByUserId = new Map<string, Map<string, DailyStatItem>>();
    for (const id of memberIds) {
      statsByUserId.set(id, new Map());
    }

    if (range === 'daily') {
      const statItems = await batchGetItems<DailyStatItem>(
        memberIds.map((id) => ({
          PK: keys.userPk(id),
          SK: keys.statSk(anchorDate),
        })),
      );
      for (const stat of statItems) {
        statsByUserId.get(stat.userId)?.set(stat.date, stat);
      }
    } else {
      const startSk = keys.statSk(window.startDate);
      const endSk = keys.statSk(window.endDate);

      await Promise.all(
        memberIds.map(async (memberId) => {
          const statRes = await ddb.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: 'PK = :userPk AND SK BETWEEN :startSk AND :endSk',
              ExpressionAttributeValues: {
                ':userPk': keys.userPk(memberId),
                ':startSk': startSk,
                ':endSk': endSk,
              },
            }),
          );
          const userMap = statsByUserId.get(memberId);
          for (const item of (statRes.Items as DailyStatItem[] | undefined) ?? []) {
            userMap?.set(item.date, item);
          }
        }),
      );
    }

    const unranked: UnrankedRaceStanding[] = memberIds.map((memberId, index) => {
      const profile = profileByUserId.get(memberId);
      const targets = {
        dailyStepTarget: profile?.dailyStepTarget ?? DEFAULT_DAILY_STEP_TARGET,
        dailyCalorieTarget: profile?.dailyCalorieTarget ?? DEFAULT_DAILY_CALORIE_TARGET,
        stepWeight: profile?.stepWeight ?? DEFAULT_STEP_WEIGHT,
        calorieWeight: profile?.calorieWeight ?? DEFAULT_CALORIE_WEIGHT,
      };

      const userStatsMap = statsByUserId.get(memberId) ?? new Map<string, DailyStatItem>();
      let lastUpdatedAt: string | null = null;
      for (const stat of userStatsMap.values()) {
        if (!lastUpdatedAt || stat.updatedAt > lastUpdatedAt) {
          lastUpdatedAt = stat.updatedAt;
        }
      }

      if (range === 'daily') {
        const stat = userStatsMap.get(anchorDate);
        const daily = calculateDailyScore(
          anchorDate,
          stat?.steps ?? 0,
          stat?.activeCalories ?? 0,
          targets,
        );

        return {
          userId: memberId,
          displayName: profile?.displayName ?? 'Racer',
          playerSlug: profile?.playerSlug ?? memberId.slice(0, 8),
          bikeColor: profile?.bikeColor ?? BIKE_COLOR_PALETTE[index % BIKE_COLOR_PALETTE.length],
          isCurrentUser: memberId === userId,
          isOverdrive: daily.isOverdrive,
          weightedScorePct: daily.weightedScorePct,
          stepPct: daily.stepPct,
          caloriePct: daily.caloriePct,
          steps: daily.steps,
          activeCalories: daily.activeCalories,
          stepTarget: targets.dailyStepTarget,
          calorieTarget: targets.dailyCalorieTarget,
          stepWeight: targets.stepWeight,
          calorieWeight: targets.calorieWeight,
          daysLogged: stat ? 1 : 0,
          lastUpdatedAt,
          dailyBreakdown: [daily],
        };
      }

      const weekly = calculateWeeklyScore(window.dates, userStatsMap, targets);
      return {
        userId: memberId,
        displayName: profile?.displayName ?? 'Racer',
        playerSlug: profile?.playerSlug ?? memberId.slice(0, 8),
        bikeColor: profile?.bikeColor ?? BIKE_COLOR_PALETTE[index % BIKE_COLOR_PALETTE.length],
        isCurrentUser: memberId === userId,
        isOverdrive: weekly.isOverdrive,
        weightedScorePct: weekly.weightedScorePct,
        stepPct: weekly.stepPct,
        caloriePct: weekly.caloriePct,
        steps: weekly.totalSteps,
        activeCalories: weekly.totalActiveCalories,
        stepTarget: targets.dailyStepTarget * 7,
        calorieTarget: targets.dailyCalorieTarget * 7,
        stepWeight: targets.stepWeight,
        calorieWeight: targets.calorieWeight,
        daysLogged: weekly.daysLogged,
        lastUpdatedAt,
        dailyBreakdown: weekly.dailyBreakdown,
      };
    });

    const response: RaceResponse = {
      group: {
        groupId: groupMeta.groupId,
        name: groupMeta.name,
        inviteCode: groupMeta.inviteCode,
      },
      range,
      date: anchorDate,
      startDate: window.startDate,
      endDate: window.endDate,
      standings: rankRaceStandings(unranked),
      generatedAt: new Date().toISOString(),
    };

    return jsonResponse(200, response);
  } catch (err) {
    return handleError(err);
  }
};
