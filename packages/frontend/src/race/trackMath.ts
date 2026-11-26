import type { RaceRange, RaceResponse, RaceStanding } from '@activity-racer/shared';

export const TRACK_IMAGE_WIDTH = 1024;
export const TRACK_IMAGE_HEIGHT = 571;

/**
 * 3D world-space dimensions of the textured velodrome ground plane.
 * Aspect ratio exactly matches race-track.jpg (1024 x 571).
 */
export const TRACK_PLANE_WIDTH = 16;
export const TRACK_PLANE_HEIGHT = TRACK_PLANE_WIDTH * (TRACK_IMAGE_HEIGHT / TRACK_IMAGE_WIDTH);
export const TRACK_UNITS_PER_PX = TRACK_PLANE_WIDTH / TRACK_IMAGE_WIDTH;

export const DAILY_BASE_DURATION_SEC = 8.0;
export const WEEKLY_DAY_DURATION_SEC = 5.0;

export interface TrackConfig {
  /** World X center of the oval */
  centerX: number;
  /** World Z center of the oval */
  centerZ: number;
  /** Half-length of each straightaway (distance from centerX to semicircle center) */
  halfStraight: number;
  /** Radius from semicircle center to the middle of the wooden boards */
  baseRadius: number;
  /** Innermost lane radial offset relative to baseRadius (near measurement line) */
  minLaneOffset: number;
  /** Outermost lane radial offset relative to baseRadius (upper wooden boards) */
  maxLaneOffset: number;
  /** World X coordinate of the bottom straightaway checkered finish line */
  finishLineX: number;
  /** Maximum inward banking roll angle (degrees) in the semicircular turns */
  maxBankAngleDeg: number;
  /** Arc distance (world units) over which banking eases in/out at turn boundaries */
  bankTransitionLength: number;
}

/**
 * Pixel-calibrated stadium geometry matching src/assets/race-track.jpg (1024 x 571):
 * - Wooden track top band: py 49..145 (center 97)
 * - Wooden track bottom band: py 435..521 (center 478)
 * - Wooden track left band: px 44..138 (center 91)
 * - Wooden track right band: px 885..979 (center 932)
 * - Bottom checkered finish line: px 624.5
 */
export const DEFAULT_TRACK_CONFIG: Readonly<TrackConfig> = Object.freeze({
  centerX: (511.5 - TRACK_IMAGE_WIDTH / 2) * TRACK_UNITS_PER_PX,
  centerZ: (287.5 - TRACK_IMAGE_HEIGHT / 2) * TRACK_UNITS_PER_PX,
  halfStraight: 230 * TRACK_UNITS_PER_PX,
  baseRadius: 190.5 * TRACK_UNITS_PER_PX,
  minLaneOffset: -0.42,
  maxLaneOffset: 0.36,
  finishLineX: (624.5 - TRACK_IMAGE_WIDTH / 2) * TRACK_UNITS_PER_PX,
  maxBankAngleDeg: 28,
  bankTransitionLength: 1.45,
});

export type TrackSegmentKind = 'bottom-straight' | 'right-turn' | 'top-straight' | 'left-turn';

export interface TrackPose {
  /** World X coordinate on the ground plane */
  x: number;
  /** World Z coordinate on the ground plane */
  z: number;
  /** Unit tangent X component along counter-clockwise travel direction */
  tangentX: number;
  /** Unit tangent Z component along counter-clockwise travel direction */
  tangentZ: number;
  /** Analytical heading angle atan2(dz, dx) in radians */
  headingRad: number;
  /** Inward velodrome banking lean angle in radians (0 on straights, up to ~28 deg in turns) */
  bankAngleRad: number;
  /** Active track section for debugging and test verification */
  segment: TrackSegmentKind;
  /** Effective turn radius (baseRadius + laneOffset) */
  radius: number;
  /** Full lap perimeter at this lane's radius */
  perimeter: number;
}

export interface TimelineDaySegment {
  index: number;
  date: string;
  shortLabel: string;
  fullLabel: string;
  isUpcoming: boolean;
}

export interface RiderTimelineTrack {
  standing: RaceStanding;
  laneIndex: number;
  laneOffset: number;
  /** Laps gained on each active day (dayScorePct / 100) */
  dailyLaps: number[];
  /** Cumulative laps at each boundary k = 0..activeSegmentCount */
  cumulativeLaps: number[];
  /** Monotone cubic Hermite slopes (laps per timeline unit) at each boundary k */
  tangents: number[];
  /** Total cumulative laps at t = activeSegmentCount */
  totalLaps: number;
}

export interface RaceTimeline {
  range: RaceRange;
  activeSegmentCount: number;
  secondsPerSegment: number;
  baseDurationSec: number;
  days: TimelineDaySegment[];
  riders: RiderTimelineTrack[];
}

export interface RiderFrameState {
  userId: string;
  standing: RaceStanding;
  laneIndex: number;
  laneOffset: number;
  /** Cumulative laps ridden so far at timeline t */
  laps: number;
  /** Instantaneous speed in laps per timeline unit (day segment) */
  velocity: number;
  /** Instantaneous speed in laps per second at 1x playback */
  lapsPerSecond: number;
  /** Live score percentage (daily: laps*100; weekly: cumulative weekly average (laps*100)/7) */
  livePct: number;
  /** Active day's score percentage */
  activeDayScorePct: number;
  /** True when currently in overdrive burst (>100% daily or >100% weekly) */
  isOverdrive: boolean;
  /** Dynamic rank at the current playback instant (1-indexed) */
  liveRank: number;
  /** True if currently leading (with laps > 0) */
  isLiveLeader: boolean;
  /** 3D track position, tangent heading, and banking angle */
  pose: TrackPose;
}

export interface RaceTimelineFrame {
  /** Clamped timeline cursor in [0, activeSegmentCount] */
  t: number;
  /** Normalized progress in [0, 1] */
  progress: number;
  /** Index of the active day segment in timeline.days */
  activeDayIndex: number;
  /** Active day metadata */
  activeDay: TimelineDaySegment;
  /** Per-rider sampled state in stable rider order */
  riders: RiderFrameState[];
  /** Riders sorted by live dynamic rank (1st, 2nd, ...) */
  liveStandings: RiderFrameState[];
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) {
    return x >= edge1 ? 1 : 0;
  }
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Computes a deterministic radial lane offset across the wooden track boards so
 * riders at similar progress ride side-by-side instead of overlapping.
 */
export function computeLaneOffset(
  laneIndex: number,
  laneCount: number,
  config: TrackConfig = DEFAULT_TRACK_CONFIG,
): number {
  if (laneCount <= 1) {
    return 0;
  }
  const clampedIndex = Math.max(0, Math.min(laneCount - 1, laneIndex));
  const fraction = clampedIndex / (laneCount - 1);

  // Keep small fields (2-4 riders) slightly grouped toward the racing line
  // while utilizing the full board width for larger groups.
  const spreadScale = Math.min(1, 0.45 + (laneCount - 1) * 0.14);
  const center = (config.minLaneOffset + config.maxLaneOffset) * 0.5;
  const halfSpan = (config.maxLaneOffset - config.minLaneOffset) * 0.5 * spreadScale;
  return center + (fraction * 2 - 1) * halfSpan;
}

/**
 * Assigns deterministic lane indices keyed by userId so riders never jump lanes
 * when background polling updates live standings.
 */
export function assignDeterministicLanes(
  standings: readonly RaceStanding[],
  config: TrackConfig = DEFAULT_TRACK_CONFIG,
): Map<string, { laneIndex: number; laneOffset: number }> {
  const sortedIds = [...standings].map((s) => s.userId).sort((a, b) => a.localeCompare(b));
  const count = sortedIds.length;
  const map = new Map<string, { laneIndex: number; laneOffset: number }>();

  for (let i = 0; i < count; i++) {
    map.set(sortedIds[i], {
      laneIndex: i,
      laneOffset: computeLaneOffset(i, count, config),
    });
  }
  return map;
}

/**
 * Evaluates a rider's 3D ground position, analytical tangent heading, and inward
 * banking angle at any arc-length progress `laps` (1.0 lap = 100% of one circuit).
 *
 * Direction is counter-clockwise starting from the bottom straightaway checkered
 * finish line (heading +X on the bottom straight, around the right turn, -X along
 * the top straight, and around the left turn back to the finish line).
 */
export function evaluateTrackPose(
  laps: number,
  laneOffset = 0,
  config: TrackConfig = DEFAULT_TRACK_CONFIG,
): TrackPose {
  const radius = Math.max(0.5, config.baseRadius + laneOffset);
  const straightLength = 2 * config.halfStraight;
  const turnLength = Math.PI * radius;
  const perimeter = 2 * straightLength + 2 * turnLength;

  // Distance along bottom straight from left turn exit (centerX - halfStraight) to finish line
  const rawFinishOffset = config.finishLineX - (config.centerX - config.halfStraight);
  const finishOffset = Math.max(0, Math.min(straightLength, rawFinishOffset));

  const safeLaps = Number.isFinite(laps) ? laps : 0;
  const wrappedLaps = ((safeLaps % 1) + 1) % 1;
  const s = (wrappedLaps * perimeter + finishOffset) % perimeter;

  const maxBankRad = (config.maxBankAngleDeg * Math.PI) / 180;
  const transition = Math.max(0.01, config.bankTransitionLength);

  const s1 = straightLength;
  const s2 = straightLength + turnLength;
  const s3 = 2 * straightLength + turnLength;

  let x: number;
  let z: number;
  let tangentX: number;
  let tangentZ: number;
  let bankAngleRad = 0;
  let segment: TrackSegmentKind;

  if (s < s1) {
    // Bottom straightaway: left -> right (+X)
    segment = 'bottom-straight';
    x = config.centerX - config.halfStraight + s;
    z = config.centerZ + radius;
    tangentX = 1;
    tangentZ = 0;
    bankAngleRad = 0;
  } else if (s < s2) {
    // Right semicircular turn: bottom (+Z) -> right apex (+X) -> top (-Z)
    segment = 'right-turn';
    const arcInTurn = s - s1;
    const u = arcInTurn / radius; // 0 .. PI
    const theta = Math.PI / 2 - u; // +PI/2 .. -PI/2
    x = config.centerX + config.halfStraight + radius * Math.cos(theta);
    z = config.centerZ + radius * Math.sin(theta);
    tangentX = Math.sin(theta);
    tangentZ = -Math.cos(theta);

    const distFromTurnEdge = Math.min(arcInTurn, turnLength - arcInTurn);
    bankAngleRad = maxBankRad * smoothstep(0, transition, distFromTurnEdge);
  } else if (s < s3) {
    // Top straightaway: right -> left (-X)
    segment = 'top-straight';
    const d = s - s2;
    x = config.centerX + config.halfStraight - d;
    z = config.centerZ - radius;
    tangentX = -1;
    tangentZ = 0;
    bankAngleRad = 0;
  } else {
    // Left semicircular turn: top (-Z) -> left apex (-X) -> bottom (+Z)
    segment = 'left-turn';
    const arcInTurn = s - s3;
    const u = arcInTurn / radius; // 0 .. PI
    const theta = -Math.PI / 2 - u; // -PI/2 .. -3*PI/2
    x = config.centerX - config.halfStraight + radius * Math.cos(theta);
    z = config.centerZ + radius * Math.sin(theta);
    tangentX = Math.sin(theta);
    tangentZ = -Math.cos(theta);

    const distFromTurnEdge = Math.min(arcInTurn, turnLength - arcInTurn);
    bankAngleRad = maxBankRad * smoothstep(0, transition, distFromTurnEdge);
  }

  return {
    x,
    z,
    tangentX,
    tangentZ,
    headingRad: Math.atan2(tangentZ, tangentX),
    bankAngleRad,
    segment,
    radius,
    perimeter,
  };
}

/**
 * Computes C1-continuous, strictly monotonic cubic Hermite (PCHIP) boundary tangents:
 * - Zero velocity at race start (t = 0) and race finish (t = N) for smooth ease-in/out.
 * - Harmonic mean at interior day transitions so riders smoothly accelerate/decelerate
 *   across days without ever overshooting or rolling backward on 0% rest days.
 */
export function computeMonotoneTangents(deltas: readonly number[]): number[] {
  const n = deltas.length;
  const tangents = new Array<number>(n + 1).fill(0);

  for (let k = 1; k < n; k++) {
    const dPrev = Math.max(0, deltas[k - 1]);
    const dNext = Math.max(0, deltas[k]);
    if (dPrev <= 0 || dNext <= 0) {
      tangents[k] = 0;
    } else {
      // Harmonic mean is always <= 2 * min(dPrev, dNext), guaranteeing monotonicity
      tangents[k] = (2 * dPrev * dNext) / (dPrev + dNext);
    }
  }
  return tangents;
}

/**
 * Samples cumulative distance and instantaneous velocity (laps per day segment)
 * from a monotone cubic Hermite spline.
 */
export function sampleHermiteProgress(
  cumulativeLaps: readonly number[],
  tangents: readonly number[],
  t: number,
): { laps: number; velocity: number } {
  const segmentCount = Math.max(1, cumulativeLaps.length - 1);
  if (t <= 0) {
    return { laps: cumulativeLaps[0] ?? 0, velocity: 0 };
  }
  if (t >= segmentCount) {
    return { laps: cumulativeLaps[segmentCount] ?? 0, velocity: 0 };
  }

  const seg = Math.min(segmentCount - 1, Math.floor(t));
  const u = t - seg;
  const u2 = u * u;
  const u3 = u2 * u;

  const y0 = cumulativeLaps[seg];
  const y1 = cumulativeLaps[seg + 1];
  const m0 = tangents[seg];
  const m1 = tangents[seg + 1];

  // Cubic Hermite basis functions
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  const laps = h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1;

  // Analytical derivative d/du
  const dh00 = 6 * u2 - 6 * u;
  const dh10 = 3 * u2 - 4 * u + 1;
  const dh01 = -6 * u2 + 6 * u;
  const dh11 = 3 * u2 - 2 * u;

  const velocity = Math.max(0, dh00 * y0 + dh10 * m0 + dh01 * y1 + dh11 * m1);

  return { laps, velocity };
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAY_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export function formatDayLabels(isoDate: string): { shortLabel: string; fullLabel: string } {
  const parts = isoDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return { shortLabel: isoDate, fullLabel: isoDate };
  }
  const utc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const dow = utc.getUTCDay();
  return {
    shortLabel: WEEKDAY_SHORT[dow],
    fullLabel: `${WEEKDAY_LONG[dow]} · ${isoDate}`,
  };
}

function getLocalTodayIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Builds the multi-day animation timeline from a RaceResponse.
 *
 * - Daily view: 1 segment (t in [0, 1]), each rider runs 0 -> weightedScorePct / 100 laps.
 * - Weekly view: N active segments (Mon up through today for the current week, or all 7
 *   days for past weeks). Future days after today with zero logged activity are marked
 *   upcoming so playback ends cleanly on the latest active day.
 */
export function buildRaceTimeline(
  race: RaceResponse,
  options?: {
    todayIso?: string;
    trackConfig?: TrackConfig;
  },
): RaceTimeline {
  const config = options?.trackConfig ?? DEFAULT_TRACK_CONFIG;
  const todayIso = options?.todayIso ?? getLocalTodayIsoDate();

  // Extract canonical ordered date list from standings breakdown (fallback to race.date)
  const templateBreakdown = race.standings[0]?.dailyBreakdown ?? [];
  const rawDates =
    templateBreakdown.length > 0 ? templateBreakdown.map((d) => d.date) : [race.date];

  let activeSegmentCount = rawDates.length;

  if (race.range === 'weekly' && rawDates.length > 1) {
    const startDate = rawDates[0];
    const endDate = rawDates[rawDates.length - 1];

    if (todayIso >= startDate && todayIso <= endDate) {
      // Current week: advance through today (or latest day with any synced score if ahead in UTC)
      let lastActiveIdx = rawDates.findIndex((d) => d === todayIso);
      if (lastActiveIdx < 0) {
        lastActiveIdx = rawDates.length - 1;
      }
      for (const standing of race.standings) {
        standing.dailyBreakdown.forEach((entry, idx) => {
          if (entry.weightedScorePct > 0 && idx > lastActiveIdx) {
            lastActiveIdx = idx;
          }
        });
      }
      activeSegmentCount = Math.max(1, lastActiveIdx + 1);
    } else if (todayIso < startDate) {
      // Future week: keep 1 segment so timeline range is non-degenerate
      activeSegmentCount = 1;
    } else {
      // Past week: play all 7 days
      activeSegmentCount = rawDates.length;
    }
  } else {
    activeSegmentCount = 1;
  }

  const days: TimelineDaySegment[] = rawDates.map((isoDate, index) => {
    const { shortLabel, fullLabel } = formatDayLabels(isoDate);
    return {
      index,
      date: isoDate,
      shortLabel,
      fullLabel,
      isUpcoming: race.range === 'weekly' && index >= activeSegmentCount,
    };
  });

  const lanes = assignDeterministicLanes(race.standings, config);
  const secondsPerSegment =
    race.range === 'weekly' ? WEEKLY_DAY_DURATION_SEC : DAILY_BASE_DURATION_SEC;

  const riders: RiderTimelineTrack[] = race.standings.map((standing) => {
    const lane = lanes.get(standing.userId) ?? { laneIndex: 0, laneOffset: 0 };
    const dailyLaps: number[] = [];

    if (race.range === 'daily') {
      const pct = standing.dailyBreakdown[0]?.weightedScorePct ?? standing.weightedScorePct;
      dailyLaps.push(Math.max(0, pct / 100));
    } else {
      for (let d = 0; d < activeSegmentCount; d++) {
        const entry = standing.dailyBreakdown[d];
        const pct = entry ? entry.weightedScorePct : 0;
        dailyLaps.push(Math.max(0, pct / 100));
      }
    }

    const cumulativeLaps: number[] = [0];
    for (let d = 0; d < dailyLaps.length; d++) {
      cumulativeLaps.push(cumulativeLaps[d] + dailyLaps[d]);
    }

    const tangents = computeMonotoneTangents(dailyLaps);
    return {
      standing,
      laneIndex: lane.laneIndex,
      laneOffset: lane.laneOffset,
      dailyLaps,
      cumulativeLaps,
      tangents,
      totalLaps: cumulativeLaps[cumulativeLaps.length - 1],
    };
  });

  return {
    range: race.range,
    activeSegmentCount,
    secondsPerSegment,
    baseDurationSec: activeSegmentCount * secondsPerSegment,
    days,
    riders,
  };
}

/**
 * Samples every rider's 3D pose, live cumulative progress, instantaneous velocity,
 * and dynamic live rank at timeline cursor `t` in [0, timeline.activeSegmentCount].
 */
export function sampleRaceTimeline(
  timeline: RaceTimeline,
  t: number,
  config: TrackConfig = DEFAULT_TRACK_CONFIG,
): RaceTimelineFrame {
  const maxT = timeline.activeSegmentCount;
  const clampedT = Math.max(0, Math.min(maxT, Number.isFinite(t) ? t : 0));
  const activeDayIndex = Math.min(maxT - 1, Math.floor(clampedT));
  const activeDay = timeline.days[activeDayIndex] ?? timeline.days[0];

  const sampled: RiderFrameState[] = timeline.riders.map((rider) => {
    const { laps, velocity } = sampleHermiteProgress(
      rider.cumulativeLaps,
      rider.tangents,
      clampedT,
    );
    const pose = evaluateTrackPose(laps, rider.laneOffset, config);
    const activeDayScorePct = (rider.dailyLaps[activeDayIndex] ?? 0) * 100;
    const livePct = timeline.range === 'weekly' ? (laps * 100) / 7 : laps * 100;
    const isOverdrive =
      timeline.range === 'weekly'
        ? (activeDayScorePct > 100 && velocity > 0.01) || livePct > 100
        : laps > 1;

    return {
      userId: rider.standing.userId,
      standing: rider.standing,
      laneIndex: rider.laneIndex,
      laneOffset: rider.laneOffset,
      laps,
      velocity,
      lapsPerSecond: velocity / timeline.secondsPerSegment,
      livePct,
      activeDayScorePct,
      isOverdrive,
      liveRank: rider.standing.rank,
      isLiveLeader: false,
      pose,
    };
  });

  // Compute live dynamic rank order at time t
  const ranked = [...sampled].sort((a, b) => {
    if (Math.abs(b.laps - a.laps) > 1e-6) {
      return b.laps - a.laps;
    }
    return a.standing.rank - b.standing.rank;
  });

  const topLaps = ranked.length > 0 ? ranked[0].laps : 0;
  const rankById = new Map<string, { rank: number; isLeader: boolean }>();
  ranked.forEach((entry, idx) => {
    rankById.set(entry.userId, {
      rank: idx + 1,
      isLeader: topLaps > 1e-6 && Math.abs(entry.laps - topLaps) <= 1e-6,
    });
  });

  for (const item of sampled) {
    const info = rankById.get(item.userId);
    if (info) {
      item.liveRank = info.rank;
      item.isLiveLeader = info.isLeader;
    }
  }

  return {
    t: clampedT,
    progress: maxT > 0 ? clampedT / maxT : 1,
    activeDayIndex,
    activeDay,
    riders: sampled,
    liveStandings: ranked,
  };
}

/**
 * Identifies a distinct race view (group + range + date window). When this changes,
 * playback resets to the start (or finish for prefers-reduced-motion).
 */
export function computeRaceIdentity(race: RaceResponse): string {
  return `${race.group.groupId}|${race.range}|${race.startDate}|${race.endDate}`;
}

/**
 * Deterministic fingerprint of race scoring data, intentionally excluding polling
 * timestamps (`generatedAt`, `lastUpdatedAt`) so identical 30s refreshes do not
 * disturb or reset playback.
 */
export function computeRaceDataSignature(race: RaceResponse): string {
  const rows = race.standings
    .map((s) => {
      const days = s.dailyBreakdown.map((d) => `${d.date}:${d.weightedScorePct}`).join(',');
      return `${s.userId}|${s.displayName}|${s.bikeColor}|${s.weightedScorePct}|${days}`;
    })
    .join(';');
  return `${computeRaceIdentity(race)}::${rows}`;
}

/**
 * Deterministic fingerprint of the narrative-defining race outcome (active days, daily leaders,
 * daily rank order, overdrive status, active/resting state, and rider names), intentionally
 * excluding raw step/calorie/lap magnitudes. Mirrors backend `computeOutcomeHash` so minor step
 * trickles do not mark commentary stale, while rank/leader/winner/overdrive/first-activity
 * changes do.
 */
export function computeRaceOutcomeSignature(
  race: RaceResponse,
  options?: { todayIso?: string },
): string {
  const todayIso = options?.todayIso ?? getLocalTodayIsoDate();
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
  const cumulativeByUser = new Map<string, number>();
  let hasAnyActivity = false;

  const dayTokens = activeDates.map((date, dayIdx) => {
    const entries = race.standings.map((standing) => {
      const breakdown = standing.dailyBreakdown[dayIdx];
      const dayPct = breakdown ? breakdown.weightedScorePct : 0;
      const dayLaps = Math.round(Math.max(0, dayPct / 100) * 100) / 100;
      if (dayLaps > 0) {
        hasAnyActivity = true;
      }
      const nextCum = Math.round(((cumulativeByUser.get(standing.userId) ?? 0) + dayLaps) * 100) / 100;
      cumulativeByUser.set(standing.userId, nextCum);

      return {
        userId: standing.userId,
        displayName: standing.displayName.trim(),
        cumulativeLaps: nextCum,
        inOverdrive: dayLaps > 1,
        resting: dayLaps === 0,
        finalRankTiebreak: standing.rank,
      };
    });

    entries.sort((a, b) => {
      if (b.cumulativeLaps !== a.cumulativeLaps) {
        return b.cumulativeLaps - a.cumulativeLaps;
      }
      return a.finalRankTiebreak - b.finalRankTiebreak;
    });

    const topCum = entries[0]?.cumulativeLaps ?? 0;
    const leaders =
      topCum > 0
        ? entries
            .filter((e) => e.cumulativeLaps === topCum)
            .map((e) => e.userId)
            .join(',')
        : '';

    const riders = entries
      .map(
        (e, idx) =>
          `${idx + 1}:${e.userId}:${e.displayName}:${e.inOverdrive ? 1 : 0}:${e.resting ? 1 : 0}`,
      )
      .join(',');

    return `${date}|L=${leaders}|R=${riders}`;
  });

  return `${computeRaceIdentity(race)}::A=${hasAnyActivity ? 1 : 0}::${dayTokens.join(';')}`;
}
