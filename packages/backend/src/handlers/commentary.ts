import crypto from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  getTodayIsoDate,
  type RaceCommentaryDay,
  type RaceCommentaryResponse,
  type RaceRange,
  type RaceResponse,
} from '@activity-racer/shared';
import { getAuthClaims } from '../lib/auth';
import { ddb, getTableName, keys, type RaceCommentaryItem } from '../lib/db';
import { HttpError, handleError, jsonResponse } from '../lib/http';
import { loadGroupRaceData } from '../lib/raceLoader';

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const COMMENTARY_PROMPT_VERSION = 2;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5-minute regeneration cooldown for Free Tier protection
const MODEL_CACHE_TTL_MS = 60 * 1000; // Re-check SSM model param every 60s so changes take effect without redeploy
const GEMINI_TIMEOUT_MS = 18_000;

const ssm = new SSMClient({});
let cachedGeminiApiKey: string | null = null;
let cachedGeminiModel: { value: string; expiresAt: number } | null = null;

const WEEKDAY_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function getDayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  return WEEKDAY_LONG[utc.getUTCDay()] ?? isoDate;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Maps each rider to their first name (e.g. "Andy Lee" -> "Andy").
 * Only appends a last initial ("Alex S.") if two riders in the same group share a first name.
 */
function buildShortNameMap(
  standings: readonly { userId: string; displayName: string }[],
): Map<string, string> {
  const partsByUser = standings.map((s) => {
    const parts = s.displayName.trim().split(/\s+/).filter(Boolean);
    const first = parts[0] || 'Racer';
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    return { userId: s.userId, first, last };
  });

  const firstCounts = new Map<string, number>();
  for (const p of partsByUser) {
    const key = p.first.toLowerCase();
    firstCounts.set(key, (firstCounts.get(key) ?? 0) + 1);
  }

  const result = new Map<string, string>();
  for (const p of partsByUser) {
    const hasCollision = (firstCounts.get(p.first.toLowerCase()) ?? 0) > 1;
    if (hasCollision && p.last) {
      result.set(p.userId, `${p.first} ${p.last.charAt(0).toUpperCase()}.`);
    } else {
      result.set(p.userId, p.first);
    }
  }
  return result;
}

interface DayRiderProgress {
  name: string;
  dayLaps: number;
  cumulativeLaps: number;
  rank: number;
  previousRank: number | null;
  gapBehindLeaderLaps: number;
  inOverdrive: boolean;
  resting: boolean;
}

interface DayProgressionSnapshot {
  date: string;
  dayLabel: string;
  isFinalDay: boolean;
  riders: DayRiderProgress[];
  leaderNames: string[];
  overtakes: string[];
}

interface RaceProgressionSnapshot {
  range: RaceRange;
  startDate: string;
  endDate: string;
  includesFinalDay: boolean;
  hasAnyActivity: boolean;
  days: DayProgressionSnapshot[];
  finalWinners: string[];
}

/**
 * Builds a pure-racing, privacy-safe day-by-day progression snapshot.
 * Intentionally excludes raw steps, calories, targets, emails, userIds, and webhook keys.
 */
function buildRaceProgressionSnapshot(
  race: RaceResponse,
  todayIso: string = getTodayIsoDate(),
): RaceProgressionSnapshot {
  const templateBreakdown = race.standings[0]?.dailyBreakdown ?? [];
  const rawDates =
    templateBreakdown.length > 0 ? templateBreakdown.map((d) => d.date) : [race.date];

  let activeCount = rawDates.length;
  if (race.range === 'weekly' && rawDates.length > 1) {
    const start = rawDates[0];
    const end = rawDates[rawDates.length - 1];
    if (todayIso >= start && todayIso <= end) {
      let lastIdx = rawDates.findIndex((d) => d === todayIso);
      if (lastIdx < 0) lastIdx = rawDates.length - 1;
      for (const s of race.standings) {
        s.dailyBreakdown.forEach((entry, idx) => {
          if (entry.weightedScorePct > 0 && idx > lastIdx) {
            lastIdx = idx;
          }
        });
      }
      activeCount = Math.max(1, lastIdx + 1);
    } else if (todayIso < start) {
      activeCount = 1;
    }
  } else {
    activeCount = 1;
  }

  const activeDates = rawDates.slice(0, activeCount);
  const shortNames = buildShortNameMap(race.standings);
  const cumulativeByUser = new Map<string, number>();
  const prevRankByUser = new Map<string, number>();
  let hasAnyActivity = false;

  const days: DayProgressionSnapshot[] = activeDates.map((date, dayIdx) => {
    const dayLabel = getDayLabel(date);
    const isFinalDay =
      race.range === 'daily' || (race.range === 'weekly' && dayIdx === rawDates.length - 1);

    const entries = race.standings.map((standing) => {
      const breakdown = standing.dailyBreakdown[dayIdx];
      const dayPct = breakdown ? breakdown.weightedScorePct : 0;
      const dayLaps = round2(Math.max(0, dayPct / 100));
      if (dayLaps > 0) {
        hasAnyActivity = true;
      }
      const nextCum = round2((cumulativeByUser.get(standing.userId) ?? 0) + dayLaps);
      cumulativeByUser.set(standing.userId, nextCum);

      return {
        userId: standing.userId,
        name: shortNames.get(standing.userId) ?? standing.displayName,
        dayLaps,
        cumulativeLaps: nextCum,
        inOverdrive: dayLaps > 1,
        resting: dayLaps === 0,
        finalRankTiebreak: standing.rank,
      };
    });

    // Sort by cumulative laps descending to determine end-of-day standings
    entries.sort((a, b) => {
      if (b.cumulativeLaps !== a.cumulativeLaps) {
        return b.cumulativeLaps - a.cumulativeLaps;
      }
      return a.finalRankTiebreak - b.finalRankTiebreak;
    });

    const topCum = entries[0]?.cumulativeLaps ?? 0;
    const leaderNames =
      topCum > 0
        ? entries.filter((e) => e.cumulativeLaps === topCum).map((e) => e.name)
        : [];

    const overtakes: string[] = [];
    const riders: DayRiderProgress[] = entries.map((entry, idx) => {
      const rank = idx + 1;
      const previousRank = prevRankByUser.get(entry.userId) ?? null;
      if (previousRank !== null && rank < previousRank && entry.dayLaps > 0) {
        overtakes.push(`${entry.name} surged from #${previousRank} to #${rank}`);
      }
      prevRankByUser.set(entry.userId, rank);

      return {
        name: entry.name,
        dayLaps: entry.dayLaps,
        cumulativeLaps: entry.cumulativeLaps,
        rank,
        previousRank,
        gapBehindLeaderLaps: round2(Math.max(0, topCum - entry.cumulativeLaps)),
        inOverdrive: entry.inOverdrive,
        resting: entry.resting,
      };
    });

    return {
      date,
      dayLabel,
      isFinalDay,
      riders,
      leaderNames,
      overtakes,
    };
  });

  const lastDay = days[days.length - 1];
  const includesFinalDay = Boolean(lastDay?.isFinalDay);
  const finalWinners = includesFinalDay ? (lastDay?.leaderNames ?? []) : [];

  return {
    range: race.range,
    startDate: race.startDate,
    endDate: race.endDate,
    includesFinalDay,
    hasAnyActivity,
    days,
    finalWinners,
  };
}

function computeSnapshotHash(snapshot: RaceProgressionSnapshot): string {
  const canonical = JSON.stringify({
    v: COMMENTARY_PROMPT_VERSION,
    range: snapshot.range,
    startDate: snapshot.startDate,
    endDate: snapshot.endDate,
    days: snapshot.days.map((d) => ({
      date: d.date,
      isFinalDay: d.isFinalDay,
      riders: d.riders.map((r) => [r.name, r.dayLaps, r.cumulativeLaps, r.rank, r.inOverdrive]),
    })),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Hashes only the narrative-defining outcome of the race (leaders, winners, daily rank order,
 * overtakes, overdrive state, and active/resting status), intentionally excluding raw lap counts.
 * When this hash changes, previously cached commentary could narrate the wrong outcome and must
 * bypass the 5-minute cooldown; when it stays the same, minor step trickles still respect cooldown.
 */
function computeOutcomeHash(snapshot: RaceProgressionSnapshot): string {
  const canonical = JSON.stringify({
    v: COMMENTARY_PROMPT_VERSION,
    range: snapshot.range,
    startDate: snapshot.startDate,
    endDate: snapshot.endDate,
    hasAnyActivity: snapshot.hasAnyActivity,
    includesFinalDay: snapshot.includesFinalDay,
    finalWinners: snapshot.finalWinners,
    days: snapshot.days.map((d) => ({
      date: d.date,
      isFinalDay: d.isFinalDay,
      leaderNames: d.leaderNames,
      overtakes: d.overtakes,
      riders: d.riders.map((r) => [r.name, r.rank, r.inOverdrive, r.resting]),
    })),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function getGeminiApiKey(): Promise<string> {
  if (cachedGeminiApiKey) {
    return cachedGeminiApiKey;
  }

  const paramName = process.env.GEMINI_API_KEY_PARAM?.trim();
  if (!paramName) {
    throw new HttpError(503, 'AI commentary is not enabled on this deployment.');
  }

  try {
    const res = await ssm.send(
      new GetParameterCommand({
        Name: paramName,
        WithDecryption: true,
      }),
    );
    const value = res.Parameter?.Value?.trim();
    if (!value) {
      throw new HttpError(
        503,
        'AI commentary is not configured yet (Gemini API key parameter is empty).',
      );
    }
    cachedGeminiApiKey = value;
    return value;
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      throw err;
    }
    const name = (err as { name?: string })?.name;
    if (name === 'ParameterNotFound') {
      throw new HttpError(
        503,
        `AI commentary is not configured yet. Add your Gemini API key to SSM Parameter Store at '${paramName}'.`,
      );
    }
    console.error('Failed to read Gemini API key from SSM:', err);
    throw new HttpError(503, 'Unable to load AI commentary configuration.');
  }
}

async function getGeminiModel(): Promise<string> {
  const fallback = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const paramName = process.env.GEMINI_MODEL_PARAM?.trim();
  if (!paramName) {
    return fallback;
  }

  const now = Date.now();
  if (cachedGeminiModel && cachedGeminiModel.expiresAt > now) {
    return cachedGeminiModel.value;
  }

  try {
    const res = await ssm.send(
      new GetParameterCommand({
        Name: paramName,
        WithDecryption: false,
      }),
    );
    const value = res.Parameter?.Value?.trim() || fallback;
    cachedGeminiModel = { value, expiresAt: now + MODEL_CACHE_TTL_MS };
    return value;
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name !== 'ParameterNotFound') {
      console.warn(`Failed to read Gemini model param '${paramName}' from SSM, using fallback '${fallback}':`, err);
    }
    cachedGeminiModel = { value: fallback, expiresAt: now + MODEL_CACHE_TTL_MS };
    return fallback;
  }
}

interface GeminiCommentaryPayload {
  headline: string;
  days: RaceCommentaryDay[];
  summary: string;
}

async function generateGeminiCommentary(
  apiKey: string,
  model: string,
  snapshot: RaceProgressionSnapshot,
): Promise<GeminiCommentaryPayload> {
  const systemInstruction = [
    'You are an energetic, concise velodrome track-cycling broadcast announcer calling an indoor wooden-track race.',
    'Write day-by-day race commentary designed to fit in 1–2 lines on a smartphone screen as each day animates.',
    'Rules:',
    '- Exactly 1 short punchy sentence (or 2 very brief sentences) per day — strictly 10–20 words per day max so it stays 1–2 lines on mobile.',
    '- Refer to riders ONLY by the short first names provided in the data (never invent or add last names).',
    '- Capture the excitement of the race: breakaways, overtakes, drafting, wheel-to-wheel battles, hitting Overdrive (when inOverdrive is true), holding the lead, or cruising on a recovery day.',
    '- STRICTLY FORBIDDEN: Never mention steps, calories, kcal, walking, workouts, fitness trackers, sensors, Home Assistant, percentages, or points. Talk strictly in cycling/velodrome racing terms (laps, pace, surges, lead, overdrive, finish line).',
    '- If a day has isFinalDay=true (such as Sunday in a weekly race, or a daily race), explicitly announce and celebrate the winner (or co-winners if tied in finalWinners)!',
    '- If a weekly race has not reached Sunday yet (includesFinalDay=false), build excitement for the days ahead without declaring a final weekly winner.',
    '- Return one entry in `days` for every input day, keeping the exact `date` and `dayLabel` values in order.',
  ].join('\n');

  const userPrompt = `Call this ${snapshot.range} velodrome race using the progression data below:\n${JSON.stringify(snapshot)}`;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: userPrompt }],
          },
        ],
        generationConfig: {
          temperature: 0.75,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              headline: { type: 'STRING' },
              days: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    date: { type: 'STRING' },
                    dayLabel: { type: 'STRING' },
                    commentary: { type: 'STRING' },
                  },
                  required: ['date', 'dayLabel', 'commentary'],
                },
              },
              summary: { type: 'STRING' },
            },
            required: ['headline', 'days', 'summary'],
          },
        },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`Gemini API (${model}) returned HTTP ${response.status}:`, errBody.slice(0, 500));
      if (response.status === 429) {
        throw new HttpError(429, 'AI announcer is temporarily rate-limited. Please try again shortly.');
      }
      if (response.status === 404) {
        throw new HttpError(
          502,
          `Gemini model '${model}' was not found (HTTP 404). Update /activity-racer/gemini-model in SSM Parameter Store.`,
        );
      }
      throw new HttpError(
        502,
        `AI commentary provider returned HTTP ${response.status} for model '${model}'.`,
      );
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new HttpError(502, 'AI commentary provider returned an empty response.');
    }

    const parsed = JSON.parse(rawText) as Partial<GeminiCommentaryPayload>;
    if (!parsed || !Array.isArray(parsed.days)) {
      throw new HttpError(502, 'AI commentary response did not match expected format.');
    }

    // Align and sanitize every day entry to guarantee 1-to-1 sync with the frontend timeline
    const byDate = new Map(parsed.days.map((d) => [d.date, d]));
    const normalizedDays: RaceCommentaryDay[] = snapshot.days.map((day, idx) => {
      const matched = byDate.get(day.date) ?? parsed.days?.[idx];
      const text = matched?.commentary?.trim();
      return {
        date: day.date,
        dayLabel: day.dayLabel,
        commentary: text || `${day.dayLabel} unfolds on the wooden boards!`,
      };
    });

    return {
      headline: parsed.headline?.trim() || 'Live from the Velodrome',
      days: normalizedDays,
      summary: parsed.summary?.trim() || '',
    };
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      throw err;
    }
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new HttpError(504, 'AI commentary request timed out.');
    }
    console.error('Gemini commentary generation failed:', err);
    throw new HttpError(502, 'Failed to generate AI race commentary.');
  } finally {
    clearTimeout(timeout);
  }
}

function toResponse(item: RaceCommentaryItem, cached: boolean): RaceCommentaryResponse {
  return {
    groupId: item.groupId,
    range: item.range,
    startDate: item.startDate,
    endDate: item.endDate,
    headline: item.headline,
    days: item.days,
    summary: item.summary,
    model: item.model,
    generatedAt: item.generatedAt,
    cached,
  };
}

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

    // 1. Load canonical race data & build pure-racing progression snapshot
    const race = await loadGroupRaceData({
      callerUserId: userId,
      groupId,
      range,
      anchorDate,
    });

    const snapshot = buildRaceProgressionSnapshot(race);

    // 2. Skip Gemini completely (0 cost) if no rider has moved yet
    if (!snapshot.hasAnyActivity) {
      const placeholder: RaceCommentaryResponse = {
        groupId,
        range,
        startDate: race.startDate,
        endDate: race.endDate,
        headline: 'Riders on the Starting Line',
        days: snapshot.days.map((d) => ({
          date: d.date,
          dayLabel: d.dayLabel,
          commentary: 'The peloton is clipped in at the start line — waiting for the first burst of speed!',
        })),
        summary: 'Waiting for the opening surge.',
        model: 'none',
        generatedAt: new Date().toISOString(),
        cached: true,
      };
      return jsonResponse(200, placeholder);
    }

    const dataHash = computeSnapshotHash(snapshot);
    const outcomeHash = computeOutcomeHash(snapshot);
    const tableName = getTableName();
    const pk = keys.groupPk(groupId);
    const sk = keys.commentarySk(range, race.startDate);

    // 3. Check DynamoDB cache first (zero Gemini calls on cache hit)
    const cachedRes = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: pk, SK: sk },
      }),
    );
    const existing = cachedRes.Item as RaceCommentaryItem | undefined;

    if (existing && existing.dataHash === dataHash) {
      return jsonResponse(200, toResponse(existing, true));
    }

    // 4. Enforce 5-minute regeneration cooldown ONLY for minor score trickles where the race
    // outcome (leaders, winners, daily rankings, overtakes, overdrive, resting/active) is unchanged.
    // Bypass cooldown immediately whenever the outcome flips so commentary never calls the wrong result.
    const outcomeUnchanged = Boolean(existing?.outcomeHash) && existing?.outcomeHash === outcomeHash;
    if (
      existing &&
      existing.promptVersion === COMMENTARY_PROMPT_VERSION &&
      outcomeUnchanged
    ) {
      const generatedMs = Date.parse(existing.generatedAt);
      const hasAllActiveDays = existing.days.length >= snapshot.days.length;
      if (
        hasAllActiveDays &&
        Number.isFinite(generatedMs) &&
        Date.now() - generatedMs < DEFAULT_COOLDOWN_MS
      ) {
        return jsonResponse(200, toResponse(existing, true));
      }
    }

    // 5. Fetch decrypted Gemini API key and model name from SSM Parameter Store
    const [apiKey, model] = await Promise.all([getGeminiApiKey(), getGeminiModel()]);

    // 6. Generate fresh commentary and overwrite cache item in DynamoDB
    const generated = await generateGeminiCommentary(apiKey, model, snapshot);
    const nowIso = new Date().toISOString();

    const item: RaceCommentaryItem = {
      PK: pk,
      SK: sk,
      entityType: 'RACE_COMMENTARY',
      groupId,
      range,
      startDate: race.startDate,
      endDate: race.endDate,
      dataHash,
      outcomeHash,
      promptVersion: COMMENTARY_PROMPT_VERSION,
      headline: generated.headline,
      days: generated.days,
      summary: generated.summary,
      model,
      generatedAt: nowIso,
    };

    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      }),
    );

    return jsonResponse(200, toResponse(item, false));
  } catch (err) {
    return handleError(err);
  }
};
