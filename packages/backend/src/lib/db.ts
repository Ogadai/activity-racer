import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BIKE_COLOR_PALETTE,
  DEFAULT_CALORIE_WEIGHT,
  DEFAULT_DAILY_CALORIE_TARGET,
  DEFAULT_DAILY_STEP_TARGET,
  DEFAULT_STEP_WEIGHT,
  type GroupRole,
  type PlayerProfile,
  type RaceCommentaryDay,
  type RaceRange,
} from '@activity-racer/shared';
import { generateWebhookApiKey } from './auth';

const rawClient = new DynamoDBClient({});

export const ddb = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

export function getTableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) {
    throw new Error('TABLE_NAME environment variable is not configured.');
  }
  return name;
}

export const keys = {
  userPk: (userId: string) => `USER#${userId}`,
  profileSk: () => 'PROFILE',
  slugGsiPk: (slug: string) => `SLUG#${slug}`,
  slugLockPk: (slug: string) => `SLUG#${slug}`,
  uniqueSk: () => 'UNIQUE',
  groupPk: (groupId: string) => `GROUP#${groupId}`,
  groupMetaSk: () => 'META',
  inviteGsiPk: (inviteCode: string) => `INVITE#${inviteCode}`,
  inviteLockPk: (inviteCode: string) => `INVITE#${inviteCode}`,
  memberSk: (userId: string) => `MEMBER#${userId}`,
  statSk: (date: string) => `STAT#${date}`,
  commentarySk: (range: RaceRange, startDate: string) => `COMMENTARY#${range}#${startDate}`,
};

export interface PlayerProfileItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entityType: 'PLAYER_PROFILE';
  userId: string;
  displayName: string;
  playerSlug: string;
  bikeColor: string;
  dailyStepTarget: number;
  dailyCalorieTarget: number;
  stepWeight: number;
  calorieWeight: number;
  webhookApiKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMetaItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entityType: 'GROUP';
  groupId: string;
  name: string;
  inviteCode: string;
  createdBy: string;
  createdAt: string;
}

export interface GroupMembershipItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entityType: 'MEMBERSHIP';
  groupId: string;
  userId: string;
  role: GroupRole;
  joinedAt: string;
}

export interface DailyStatItem {
  PK: string;
  SK: string;
  entityType: 'DAILY_STAT';
  userId: string;
  date: string;
  steps: number;
  activeCalories: number;
  updatedAt: string;
  source: string;
}

export interface RaceCommentaryItem {
  PK: string;
  SK: string;
  entityType: 'RACE_COMMENTARY';
  groupId: string;
  range: RaceRange;
  startDate: string;
  endDate: string;
  dataHash: string;
  headline: string;
  days: RaceCommentaryDay[];
  summary: string;
  model: string;
  generatedAt: string;
}

export function toPlayerProfile(item: PlayerProfileItem): PlayerProfile {
  return {
    userId: item.userId,
    displayName: item.displayName,
    playerSlug: item.playerSlug,
    bikeColor: item.bikeColor,
    dailyStepTarget: item.dailyStepTarget,
    dailyCalorieTarget: item.dailyCalorieTarget,
    stepWeight: item.stepWeight,
    calorieWeight: item.calorieWeight,
    webhookApiKey: item.webhookApiKey,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function pickInitialBikeColor(userId: string): string {
  const hash = crypto.createHash('sha256').update(userId).digest();
  return BIKE_COLOR_PALETTE[hash[0] % BIKE_COLOR_PALETTE.length];
}

function buildInitialDisplayName(email?: string, name?: string): string {
  if (name && name.trim().length > 0) {
    return name.trim().slice(0, 40);
  }
  if (!email) {
    return 'Racer';
  }
  const localPart = email.split('@')[0] ?? '';
  const cleaned = localPart.replace(/[._+-]+/g, ' ').trim();
  if (!cleaned) {
    return 'Racer';
  }
  return cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .slice(0, 40);
}

function buildInitialSlug(userId: string, email?: string): string {
  const baseSource = email ? (email.split('@')[0] ?? 'racer') : 'racer';
  const cleaned = baseSource
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  const prefix = cleaned.length >= 2 ? cleaned : 'racer';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${prefix}-${suffix}`.slice(0, 32);
}

export async function getPlayerProfileItem(userId: string): Promise<PlayerProfileItem | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: getTableName(),
      Key: {
        PK: keys.userPk(userId),
        SK: keys.profileSk(),
      },
    }),
  );
  return (res.Item as PlayerProfileItem | undefined) ?? null;
}

/**
 * Fetches the player's profile or atomically initializes a default profile on first visit.
 */
export async function ensurePlayerProfile(
  userId: string,
  email?: string,
  name?: string,
): Promise<PlayerProfileItem> {
  const existing = await getPlayerProfileItem(userId);
  if (existing) {
    return existing;
  }

  const tableName = getTableName();
  const now = new Date().toISOString();
  const displayName = buildInitialDisplayName(email, name);
  const bikeColor = pickInitialBikeColor(userId);

  for (let attempt = 0; attempt < 3; attempt++) {
    const playerSlug = buildInitialSlug(userId, email);
    const item: PlayerProfileItem = {
      PK: keys.userPk(userId),
      SK: keys.profileSk(),
      GSI1PK: keys.slugGsiPk(playerSlug),
      GSI1SK: keys.userPk(userId),
      entityType: 'PLAYER_PROFILE',
      userId,
      displayName,
      playerSlug,
      bikeColor,
      dailyStepTarget: DEFAULT_DAILY_STEP_TARGET,
      dailyCalorieTarget: DEFAULT_DAILY_CALORIE_TARGET,
      stepWeight: DEFAULT_STEP_WEIGHT,
      calorieWeight: DEFAULT_CALORIE_WEIGHT,
      webhookApiKey: generateWebhookApiKey(),
      createdAt: now,
      updatedAt: now,
    };

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
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
          ],
        }),
      );
      return item;
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'TransactionCanceledException') {
        const afterRace = await getPlayerProfileItem(userId);
        if (afterRace) {
          return afterRace;
        }
        // Otherwise slug collided; retry with a new random suffix
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to initialize player profile after retries.');
}

export async function batchGetItems<T>(
  keyList: Array<{ PK: string; SK: string }>,
): Promise<T[]> {
  if (keyList.length === 0) {
    return [];
  }

  const tableName = getTableName();
  const results: T[] = [];

  for (let i = 0; i < keyList.length; i += 100) {
    let pendingKeys = keyList.slice(i, i + 100);
    let retries = 0;

    while (pendingKeys.length > 0 && retries < 4) {
      const res = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [tableName]: {
              Keys: pendingKeys,
            },
          },
        }),
      );

      const fetched = (res.Responses?.[tableName] as T[] | undefined) ?? [];
      results.push(...fetched);

      const unprocessed = res.UnprocessedKeys?.[tableName]?.Keys as
        | Array<{ PK: string; SK: string }>
        | undefined;
      if (!unprocessed || unprocessed.length === 0) {
        break;
      }

      pendingKeys = unprocessed;
      retries += 1;
      await new Promise((resolve) => setTimeout(resolve, 50 * retries));
    }
  }

  return results;
}
