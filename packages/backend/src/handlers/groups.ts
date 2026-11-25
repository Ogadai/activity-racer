import crypto from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type {
  CreateGroupRequest,
  GroupSummary,
  GroupsListResponse,
  JoinGroupRequest,
} from '@activity-racer/shared';
import { generateInviteCode, getAuthClaims } from '../lib/auth';
import {
  batchGetItems,
  ddb,
  ensurePlayerProfile,
  getTableName,
  keys,
  type GroupMembershipItem,
  type GroupMetaItem,
} from '../lib/db';
import { HttpError, handleError, jsonResponse, parseJsonBody } from '../lib/http';

async function handleListGroups(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const { userId } = getAuthClaims(event);
  const tableName = getTableName();

  const membershipQuery = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :userPk AND begins_with(GSI1SK, :groupPrefix)',
      ExpressionAttributeValues: {
        ':userPk': keys.userPk(userId),
        ':groupPrefix': 'GROUP#',
      },
    }),
  );

  const memberships = (membershipQuery.Items as GroupMembershipItem[] | undefined) ?? [];
  if (memberships.length === 0) {
    const empty: GroupsListResponse = { groups: [] };
    return jsonResponse(200, empty);
  }

  const groupKeys = memberships.map((m) => ({
    PK: keys.groupPk(m.groupId),
    SK: keys.groupMetaSk(),
  }));
  const groupMetas = await batchGetItems<GroupMetaItem>(groupKeys);
  const metaById = new Map(groupMetas.map((g) => [g.groupId, g]));

  const groups: GroupSummary[] = [];
  for (const membership of memberships) {
    const meta = metaById.get(membership.groupId);
    if (!meta) {
      continue;
    }
    groups.push({
      groupId: meta.groupId,
      name: meta.name,
      inviteCode: meta.inviteCode,
      role: membership.role,
      createdBy: meta.createdBy,
      createdAt: meta.createdAt,
      joinedAt: membership.joinedAt,
    });
  }

  groups.sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));

  const response: GroupsListResponse = { groups };
  return jsonResponse(200, response);
}

async function handleCreateGroup(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const { userId, email, name: userName } = getAuthClaims(event);
  await ensurePlayerProfile(userId, email, userName);

  const body = parseJsonBody<CreateGroupRequest>(event);
  if (typeof body.name !== 'string') {
    throw new HttpError(400, 'Group name is required.');
  }
  const name = body.name.trim();
  if (name.length < 1 || name.length > 60) {
    throw new HttpError(400, 'Group name must be between 1 and 60 characters.');
  }

  const tableName = getTableName();
  const groupId = crypto.randomUUID();
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < 3; attempt++) {
    const inviteCode = generateInviteCode(8);
    const groupItem: GroupMetaItem = {
      PK: keys.groupPk(groupId),
      SK: keys.groupMetaSk(),
      GSI1PK: keys.inviteGsiPk(inviteCode),
      GSI1SK: keys.groupPk(groupId),
      entityType: 'GROUP',
      groupId,
      name,
      inviteCode,
      createdBy: userId,
      createdAt: now,
    };

    const membershipItem: GroupMembershipItem = {
      PK: keys.groupPk(groupId),
      SK: keys.memberSk(userId),
      GSI1PK: keys.userPk(userId),
      GSI1SK: keys.groupPk(groupId),
      entityType: 'MEMBERSHIP',
      groupId,
      userId,
      role: 'OWNER',
      joinedAt: now,
    };

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: groupItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  PK: keys.inviteLockPk(inviteCode),
                  SK: keys.uniqueSk(),
                  entityType: 'INVITE_LOCK',
                  groupId,
                  createdAt: now,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: membershipItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );

      const summary: GroupSummary = {
        groupId,
        name,
        inviteCode,
        role: 'OWNER',
        createdBy: userId,
        createdAt: now,
        joinedAt: now,
      };
      return jsonResponse(201, summary);
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'TransactionCanceledException') {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to generate a unique group invite code.');
}

async function handleJoinGroup(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const { userId, email, name } = getAuthClaims(event);
  await ensurePlayerProfile(userId, email, name);

  const body = parseJsonBody<JoinGroupRequest>(event);
  if (typeof body.inviteCode !== 'string') {
    throw new HttpError(400, 'inviteCode is required.');
  }
  const inviteCode = body.inviteCode.trim().toUpperCase().replace(/\s+/g, '');
  if (inviteCode.length < 4 || inviteCode.length > 32) {
    throw new HttpError(400, 'Invalid inviteCode.');
  }

  const tableName = getTableName();
  const groupQuery = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :invitePk AND begins_with(GSI1SK, :groupPrefix)',
      ExpressionAttributeValues: {
        ':invitePk': keys.inviteGsiPk(inviteCode),
        ':groupPrefix': 'GROUP#',
      },
      Limit: 1,
    }),
  );

  const groupMeta = groupQuery.Items?.[0] as GroupMetaItem | undefined;
  if (!groupMeta) {
    throw new HttpError(404, 'No group found for that invite code.');
  }

  const existingMembershipRes = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        PK: keys.groupPk(groupMeta.groupId),
        SK: keys.memberSk(userId),
      },
    }),
  );

  const existingMembership = existingMembershipRes.Item as GroupMembershipItem | undefined;
  if (existingMembership) {
    const summary: GroupSummary = {
      groupId: groupMeta.groupId,
      name: groupMeta.name,
      inviteCode: groupMeta.inviteCode,
      role: existingMembership.role,
      createdBy: groupMeta.createdBy,
      createdAt: groupMeta.createdAt,
      joinedAt: existingMembership.joinedAt,
    };
    return jsonResponse(200, summary);
  }

  const now = new Date().toISOString();
  const membershipItem: GroupMembershipItem = {
    PK: keys.groupPk(groupMeta.groupId),
    SK: keys.memberSk(userId),
    GSI1PK: keys.userPk(userId),
    GSI1SK: keys.groupPk(groupMeta.groupId),
    entityType: 'MEMBERSHIP',
    groupId: groupMeta.groupId,
    userId,
    role: 'MEMBER',
    joinedAt: now,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: membershipItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') {
      throw err;
    }
  }

  const summary: GroupSummary = {
    groupId: groupMeta.groupId,
    name: groupMeta.name,
    inviteCode: groupMeta.inviteCode,
    role: 'MEMBER',
    createdBy: groupMeta.createdBy,
    createdAt: groupMeta.createdAt,
    joinedAt: now,
  };
  return jsonResponse(200, summary);
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const rawPath = event.rawPath ?? '';

    if (method === 'GET' && rawPath.endsWith('/groups')) {
      return await handleListGroups(event);
    }
    if (method === 'POST' && rawPath.endsWith('/groups/join')) {
      return await handleJoinGroup(event);
    }
    if (method === 'POST' && rawPath.endsWith('/groups')) {
      return await handleCreateGroup(event);
    }

    throw new HttpError(404, 'Route not found.');
  } catch (err) {
    return handleError(err);
  }
};
