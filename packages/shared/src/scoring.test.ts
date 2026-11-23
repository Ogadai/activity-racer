import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDailyScore,
  calculateWeeklyScore,
  getCalendarWeekWindow,
  getDateWindow,
  isValidIsoDate,
  rankRaceStandings,
  validateScoringTargets,
} from './scoring.ts';

describe('ISO date & calendar week helpers', () => {
  it('validates real calendar dates and rejects invalid ones', () => {
    assert.equal(isValidIsoDate('2026-11-23'), true);
    assert.equal(isValidIsoDate('2024-02-29'), true);
    assert.equal(isValidIsoDate('2026-02-29'), false);
    assert.equal(isValidIsoDate('2026-13-01'), false);
    assert.equal(isValidIsoDate('2026-1-5'), false);
  });

  it('computes Monday-Sunday calendar week window for Monday, mid-week, and Sunday', () => {
    // 2026-11-23 is a Monday
    const mon = getCalendarWeekWindow('2026-11-23');
    assert.equal(mon.startDate, '2026-11-23');
    assert.equal(mon.endDate, '2026-11-29');
    assert.equal(mon.dates.length, 7);

    // 2026-11-25 is Wednesday of the same week
    const wed = getCalendarWeekWindow('2026-11-25');
    assert.equal(wed.startDate, '2026-11-23');
    assert.equal(wed.endDate, '2026-11-29');

    // 2026-11-29 is Sunday of the same week
    const sun = getCalendarWeekWindow('2026-11-29');
    assert.equal(sun.startDate, '2026-11-23');
    assert.equal(sun.endDate, '2026-11-29');

    // Daily window returns single date
    const daily = getDateWindow('daily', '2026-11-25');
    assert.deepEqual(daily, {
      startDate: '2026-11-25',
      endDate: '2026-11-25',
      dates: ['2026-11-25'],
    });
  });
});

describe('validateScoringTargets', () => {
  it('accepts valid balanced and custom weights summing to 1', () => {
    assert.equal(
      validateScoringTargets({
        dailyStepTarget: 10000,
        dailyCalorieTarget: 500,
        stepWeight: 0.5,
        calorieWeight: 0.5,
      }),
      null,
    );
    assert.equal(
      validateScoringTargets({
        dailyStepTarget: 6000,
        dailyCalorieTarget: 300,
        stepWeight: 0.7,
        calorieWeight: 0.3,
      }),
      null,
    );
  });

  it('rejects weights not summing to 1 or non-positive targets', () => {
    assert.ok(
      validateScoringTargets({
        dailyStepTarget: 10000,
        dailyCalorieTarget: 500,
        stepWeight: 0.6,
        calorieWeight: 0.6,
      }),
    );
    assert.ok(
      validateScoringTargets({
        dailyStepTarget: 0,
        dailyCalorieTarget: 500,
        stepWeight: 0.5,
        calorieWeight: 0.5,
      }),
    );
  });
});

describe('calculateDailyScore', () => {
  it('fairly handicaps players with different personal targets', () => {
    const adult = calculateDailyScore('2026-11-23', 10000, 500, {
      dailyStepTarget: 10000,
      dailyCalorieTarget: 500,
      stepWeight: 0.5,
      calorieWeight: 0.5,
    });
    const teen = calculateDailyScore('2026-11-23', 6000, 300, {
      dailyStepTarget: 6000,
      dailyCalorieTarget: 300,
      stepWeight: 0.5,
      calorieWeight: 0.5,
    });

    assert.equal(adult.weightedScorePct, 100);
    assert.equal(teen.weightedScorePct, 100);
    assert.equal(adult.isOverdrive, false);
  });

  it('applies custom step/calorie weights and detects overdrive (>100%)', () => {
    const score = calculateDailyScore('2026-11-23', 12000, 550, {
      dailyStepTarget: 10000,
      dailyCalorieTarget: 500,
      stepWeight: 0.7,
      calorieWeight: 0.3,
    });
    // stepPct = 120, calPct = 110 -> 0.7*120 + 0.3*110 = 84 + 33 = 117
    assert.equal(score.stepPct, 120);
    assert.equal(score.caloriePct, 110);
    assert.equal(score.weightedScorePct, 117);
    assert.equal(score.isOverdrive, true);
  });

  it('clamps negative stats safely to zero', () => {
    const score = calculateDailyScore('2026-11-23', -100, -50, {
      dailyStepTarget: 10000,
      dailyCalorieTarget: 500,
      stepWeight: 0.5,
      calorieWeight: 0.5,
    });
    assert.equal(score.weightedScorePct, 0);
    assert.equal(score.steps, 0);
    assert.equal(score.activeCalories, 0);
  });
});

describe('calculateWeeklyScore', () => {
  it('sums daily weighted scores across Monday-Sunday and divides by 7', () => {
    const { dates } = getCalendarWeekWindow('2026-11-25'); // Mon 23 .. Sun 29
    const stats = new Map([
      ['2026-11-23', { steps: 10000, activeCalories: 500 }], // 100%
      ['2026-11-24', { steps: 10000, activeCalories: 500 }], // 100%
      ['2026-11-25', { steps: 15000, activeCalories: 750 }], // 150%
    ]);

    const weekly = calculateWeeklyScore(dates, stats, {
      dailyStepTarget: 10000,
      dailyCalorieTarget: 500,
      stepWeight: 0.5,
      calorieWeight: 0.5,
    });

    // (100 + 100 + 150 + 0 + 0 + 0 + 0) / 7 = 350 / 7 = 50%
    assert.equal(weekly.weightedScorePct, 50);
    assert.equal(weekly.daysLogged, 3);
    assert.equal(weekly.totalSteps, 35000);
    assert.equal(weekly.totalActiveCalories, 1750);
    assert.equal(weekly.isOverdrive, false);
    assert.equal(weekly.dailyBreakdown.length, 7);
  });

  it('reaches overdrive when weekly average exceeds 100%', () => {
    const { dates } = getCalendarWeekWindow('2026-11-29');
    const stats = new Map(dates.map((d) => [d, { steps: 11000, activeCalories: 550 }]));
    const weekly = calculateWeeklyScore(dates, stats, {
      dailyStepTarget: 10000,
      dailyCalorieTarget: 500,
      stepWeight: 0.5,
      calorieWeight: 0.5,
    });
    assert.equal(weekly.weightedScorePct, 110);
    assert.equal(weekly.isOverdrive, true);
  });
});

describe('rankRaceStandings', () => {
  it('sorts by weightedScorePct desc, ties by steps desc, and marks leader', () => {
    const base = {
      bikeColor: '#2563eb',
      isCurrentUser: false,
      isOverdrive: false,
      stepPct: 100,
      caloriePct: 100,
      activeCalories: 500,
      stepTarget: 10000,
      calorieTarget: 500,
      stepWeight: 0.5,
      calorieWeight: 0.5,
      daysLogged: 1,
      lastUpdatedAt: null,
      dailyBreakdown: [],
    };

    const ranked = rankRaceStandings([
      { ...base, userId: 'u1', displayName: 'Alex', playerSlug: 'alex', weightedScorePct: 80, steps: 8000 },
      { ...base, userId: 'u2', displayName: 'Sam', playerSlug: 'sam', weightedScorePct: 100, steps: 6000 },
      { ...base, userId: 'u3', displayName: 'Jordan', playerSlug: 'jordan', weightedScorePct: 100, steps: 10000 },
    ]);

    assert.equal(ranked[0].userId, 'u3');
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[0].isLeader, true);
    assert.equal(ranked[1].userId, 'u2');
    assert.equal(ranked[1].rank, 2);
    assert.equal(ranked[1].isLeader, true); // tied for top score
    assert.equal(ranked[2].userId, 'u1');
    assert.equal(ranked[2].rank, 3);
    assert.equal(ranked[2].isLeader, false);
  });

  it('marks no leader when everyone has 0%', () => {
    const ranked = rankRaceStandings([
      {
        userId: 'u1',
        displayName: 'Alex',
        playerSlug: 'alex',
        bikeColor: '#2563eb',
        isCurrentUser: true,
        isOverdrive: false,
        weightedScorePct: 0,
        stepPct: 0,
        caloriePct: 0,
        steps: 0,
        activeCalories: 0,
        stepTarget: 10000,
        calorieTarget: 500,
        stepWeight: 0.5,
        calorieWeight: 0.5,
        daysLogged: 0,
        lastUpdatedAt: null,
        dailyBreakdown: [],
      },
    ]);
    assert.equal(ranked[0].isLeader, false);
  });
});
