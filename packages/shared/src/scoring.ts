import type {
  DailyScoreBreakdown,
  RaceRange,
  RaceStanding,
  ScoringTargets,
} from './types';

export const DEFAULT_DAILY_STEP_TARGET = 10000;
export const DEFAULT_DAILY_CALORIE_TARGET = 500;
export const DEFAULT_STEP_WEIGHT = 0.5;
export const DEFAULT_CALORIE_WEIGHT = 0.5;

export const BIKE_COLOR_PALETTE = [
  '#2563eb', // Cobalt Blue
  '#dc2626', // Racing Red
  '#16a34a', // Emerald Green
  '#ea580c', // Tangerine
  '#9333ea', // Violet
  '#0891b2', // Cyan
  '#db2777', // Magenta
  '#ca8a04', // Gold
] as const;

export const PLAYER_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEIGHT_SUM_EPSILON = 1e-4;

export function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isValidIsoDate(dateStr: string): boolean {
  const match = ISO_DATE_REGEX.exec(dateStr);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

export function formatUtcIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getTodayIsoDate(now: Date = new Date()): string {
  return formatUtcIsoDate(now);
}

function parseIsoDateUtc(dateStr: string): Date {
  if (!isValidIsoDate(dateStr)) {
    throw new Error(`Invalid ISO date: '${dateStr}'. Expected YYYY-MM-DD.`);
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addUtcDays(date: Date, deltaDays: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + deltaDays);
  return next;
}

/**
 * Returns the Monday–Sunday calendar week (7 ISO dates) containing anchorDate.
 */
export function getCalendarWeekWindow(anchorDate: string): {
  startDate: string;
  endDate: string;
  dates: string[];
} {
  const utcDate = parseIsoDateUtc(anchorDate);
  // getUTCDay(): 0 = Sun, 1 = Mon, ..., 6 = Sat -> offset from Monday: Mon=0, ..., Sun=6
  const offsetFromMonday = (utcDate.getUTCDay() + 6) % 7;
  const monday = addUtcDays(utcDate, -offsetFromMonday);

  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    dates.push(formatUtcIsoDate(addUtcDays(monday, i)));
  }

  return {
    startDate: dates[0],
    endDate: dates[6],
    dates,
  };
}

export function getDateWindow(
  range: RaceRange,
  anchorDate: string,
): {
  startDate: string;
  endDate: string;
  dates: string[];
} {
  if (!isValidIsoDate(anchorDate)) {
    throw new Error(`Invalid ISO date: '${anchorDate}'. Expected YYYY-MM-DD.`);
  }
  if (range === 'weekly') {
    return getCalendarWeekWindow(anchorDate);
  }
  return {
    startDate: anchorDate,
    endDate: anchorDate,
    dates: [anchorDate],
  };
}

export function validateScoringTargets(targets: ScoringTargets): string | null {
  const { dailyStepTarget, dailyCalorieTarget, stepWeight, calorieWeight } = targets;

  if (!Number.isFinite(dailyStepTarget) || dailyStepTarget <= 0 || dailyStepTarget > 200000) {
    return 'dailyStepTarget must be a finite number between 1 and 200000.';
  }
  if (
    !Number.isFinite(dailyCalorieTarget) ||
    dailyCalorieTarget <= 0 ||
    dailyCalorieTarget > 20000
  ) {
    return 'dailyCalorieTarget must be a finite number between 1 and 20000.';
  }
  if (!Number.isFinite(stepWeight) || stepWeight < 0 || stepWeight > 1) {
    return 'stepWeight must be between 0 and 1.';
  }
  if (!Number.isFinite(calorieWeight) || calorieWeight < 0 || calorieWeight > 1) {
    return 'calorieWeight must be between 0 and 1.';
  }
  if (Math.abs(stepWeight + calorieWeight - 1) > WEIGHT_SUM_EPSILON) {
    return 'stepWeight and calorieWeight must sum to 1.0.';
  }

  return null;
}

export function calculateDailyScore(
  date: string,
  steps: number,
  activeCalories: number,
  targets: ScoringTargets,
): DailyScoreBreakdown {
  const safeSteps = Number.isFinite(steps) && steps > 0 ? steps : 0;
  const safeCalories =
    Number.isFinite(activeCalories) && activeCalories > 0 ? activeCalories : 0;

  const stepRatio = targets.dailyStepTarget > 0 ? safeSteps / targets.dailyStepTarget : 0;
  const calorieRatio =
    targets.dailyCalorieTarget > 0 ? safeCalories / targets.dailyCalorieTarget : 0;

  const weightedRatio =
    targets.stepWeight * stepRatio + targets.calorieWeight * calorieRatio;

  const stepPct = roundPct(stepRatio * 100);
  const caloriePct = roundPct(calorieRatio * 100);
  const weightedScorePct = roundPct(weightedRatio * 100);

  return {
    date,
    steps: safeSteps,
    activeCalories: safeCalories,
    stepPct,
    caloriePct,
    weightedScorePct,
    isOverdrive: weightedScorePct > 100,
  };
}

export interface WeeklyScoreResult {
  weightedScorePct: number;
  stepPct: number;
  caloriePct: number;
  totalSteps: number;
  totalActiveCalories: number;
  daysLogged: number;
  isOverdrive: boolean;
  dailyBreakdown: DailyScoreBreakdown[];
}

/**
 * Computes a player's calendar-week score by calculating each day's normalized
 * weighted score across the 7-day Monday–Sunday window and dividing the sum by 7.
 * Missing days count as 0 so the race resets every Monday and builds toward 100% by Sunday.
 */
export function calculateWeeklyScore(
  weekDates: readonly string[],
  statsByDate: ReadonlyMap<string, { steps: number; activeCalories: number }>,
  targets: ScoringTargets,
): WeeklyScoreResult {
  const dayCount = weekDates.length > 0 ? weekDates.length : 7;
  let totalSteps = 0;
  let totalActiveCalories = 0;
  let daysLogged = 0;
  let sumStepPct = 0;
  let sumCaloriePct = 0;
  let sumWeightedPct = 0;

  const dailyBreakdown: DailyScoreBreakdown[] = weekDates.map((date) => {
    const stat = statsByDate.get(date);
    if (stat) {
      daysLogged += 1;
    }
    const steps = stat?.steps ?? 0;
    const activeCalories = stat?.activeCalories ?? 0;
    totalSteps += Math.max(0, Number.isFinite(steps) ? steps : 0);
    totalActiveCalories += Math.max(0, Number.isFinite(activeCalories) ? activeCalories : 0);

    const daily = calculateDailyScore(date, steps, activeCalories, targets);
    // Use unrounded ratios for accurate weekly average
    const stepRatio = targets.dailyStepTarget > 0 ? daily.steps / targets.dailyStepTarget : 0;
    const calRatio =
      targets.dailyCalorieTarget > 0 ? daily.activeCalories / targets.dailyCalorieTarget : 0;
    sumStepPct += stepRatio * 100;
    sumCaloriePct += calRatio * 100;
    sumWeightedPct += (targets.stepWeight * stepRatio + targets.calorieWeight * calRatio) * 100;

    return daily;
  });

  const stepPct = roundPct(sumStepPct / dayCount);
  const caloriePct = roundPct(sumCaloriePct / dayCount);
  const weightedScorePct = roundPct(sumWeightedPct / dayCount);

  return {
    weightedScorePct,
    stepPct,
    caloriePct,
    totalSteps,
    totalActiveCalories,
    daysLogged,
    isOverdrive: weightedScorePct > 100,
    dailyBreakdown,
  };
}

export type UnrankedRaceStanding = Omit<RaceStanding, 'rank' | 'isLeader'>;

export function rankRaceStandings(standings: readonly UnrankedRaceStanding[]): RaceStanding[] {
  const sorted = [...standings].sort((a, b) => {
    if (b.weightedScorePct !== a.weightedScorePct) {
      return b.weightedScorePct - a.weightedScorePct;
    }
    if (b.steps !== a.steps) {
      return b.steps - a.steps;
    }
    const nameCmp = a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: 'base',
    });
    if (nameCmp !== 0) {
      return nameCmp;
    }
    return a.userId.localeCompare(b.userId);
  });

  const topScore = sorted.length > 0 ? sorted[0].weightedScorePct : 0;

  return sorted.map((entry, idx) => ({
    ...entry,
    rank: idx + 1,
    isLeader: topScore > 0 && entry.weightedScorePct === topScore,
  }));
}
