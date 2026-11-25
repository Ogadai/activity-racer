import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RaceResponse, RaceStanding } from '@activity-racer/shared';
import {
  DEFAULT_TRACK_CONFIG,
  assignDeterministicLanes,
  buildRaceTimeline,
  computeLaneOffset,
  computeRaceDataSignature,
  computeRaceIdentity,
  evaluateTrackPose,
  sampleRaceTimeline,
} from './trackMath.ts';

function makeStanding(
  overrides: Partial<RaceStanding> & {
    userId: string;
    displayName: string;
    dailyScores: Array<{ date: string; pct: number }>;
  },
): RaceStanding {
  const dailyBreakdown = overrides.dailyScores.map((d) => ({
    date: d.date,
    steps: Math.round(d.pct * 100),
    activeCalories: Math.round(d.pct * 5),
    stepPct: d.pct,
    caloriePct: d.pct,
    weightedScorePct: d.pct,
    isOverdrive: d.pct > 100,
  }));
  const sum = dailyBreakdown.reduce((acc, d) => acc + d.weightedScorePct, 0);
  const avg = dailyBreakdown.length > 1 ? sum / 7 : sum;

  return {
    rank: overrides.rank ?? 1,
    userId: overrides.userId,
    displayName: overrides.displayName,
    playerSlug: overrides.playerSlug ?? overrides.displayName.toLowerCase(),
    bikeColor: overrides.bikeColor ?? '#2563eb',
    isCurrentUser: overrides.isCurrentUser ?? false,
    isLeader: overrides.isLeader ?? false,
    isOverdrive: avg > 100,
    weightedScorePct: overrides.weightedScorePct ?? avg,
    stepPct: avg,
    caloriePct: avg,
    steps: dailyBreakdown.reduce((acc, d) => acc + d.steps, 0),
    activeCalories: dailyBreakdown.reduce((acc, d) => acc + d.activeCalories, 0),
    stepTarget: 10000,
    calorieTarget: 500,
    stepWeight: 0.5,
    calorieWeight: 0.5,
    daysLogged: dailyBreakdown.filter((d) => d.weightedScorePct > 0).length,
    lastUpdatedAt: '2026-11-24T12:00:00Z',
    dailyBreakdown,
  };
}

describe('evaluateTrackPose stadium curve & banking', () => {
  it('starts at the bottom finish line heading +X and returns identically after 1.0 full lap', () => {
    const start = evaluateTrackPose(0, 0);
    const fullLap = evaluateTrackPose(1.0, 0);
    const twoLaps = evaluateTrackPose(2.0, 0);

    assert.equal(start.segment, 'bottom-straight');
    assert.ok(Math.abs(start.x - DEFAULT_TRACK_CONFIG.finishLineX) < 1e-6);
    assert.ok(
      Math.abs(start.z - (DEFAULT_TRACK_CONFIG.centerZ + DEFAULT_TRACK_CONFIG.baseRadius)) < 1e-6,
    );
    assert.ok(Math.abs(start.tangentX - 1) < 1e-6);
    assert.ok(Math.abs(start.tangentZ) < 1e-6);
    assert.ok(Math.abs(start.headingRad) < 1e-6);
    assert.equal(start.bankAngleRad, 0);

    // 1.0 lap and 2.0 laps wrap back to the exact finish line
    assert.ok(Math.abs(fullLap.x - start.x) < 1e-6);
    assert.ok(Math.abs(fullLap.z - start.z) < 1e-6);
    assert.ok(Math.abs(twoLaps.x - start.x) < 1e-6);
    assert.ok(Math.abs(twoLaps.z - start.z) < 1e-6);
  });

  it('travels counter-clockwise through right turn, top straight, and left turn with continuous headings', () => {
    const samples = 200;
    let sawRightApex = false;
    let sawTopStraight = false;
    let sawLeftApex = false;

    let prev = evaluateTrackPose(0, 0);
    for (let i = 1; i <= samples; i++) {
      const curr = evaluateTrackPose(i / samples, 0);
      const stepDist = Math.hypot(curr.x - prev.x, curr.z - prev.z);
      // Every step should be smooth with no jumps
      assert.ok(stepDist < prev.perimeter / samples + 0.05, `Discontinuity at step ${i}`);

      // Unit tangent check
      const tLen = Math.hypot(curr.tangentX, curr.tangentZ);
      assert.ok(Math.abs(tLen - 1) < 1e-6);

      // Right apex: rightmost X, moving upward (-Z -> heading -PI/2)
      if (curr.segment === 'right-turn' && Math.abs(curr.z - DEFAULT_TRACK_CONFIG.centerZ) < 0.25) {
        sawRightApex = true;
        assert.ok(curr.x > DEFAULT_TRACK_CONFIG.centerX + DEFAULT_TRACK_CONFIG.halfStraight);
        assert.ok(curr.tangentZ < -0.9, 'Right turn must move counter-clockwise (-Z)');
        // Banking should reach full ~28 deg at apex
        const deg = (curr.bankAngleRad * 180) / Math.PI;
        assert.ok(Math.abs(deg - DEFAULT_TRACK_CONFIG.maxBankAngleDeg) < 0.5);
      }

      // Top straight: moving left (-X), zero banking
      if (curr.segment === 'top-straight') {
        sawTopStraight = true;
        assert.ok(Math.abs(curr.tangentX + 1) < 1e-6);
        assert.equal(curr.bankAngleRad, 0);
      }

      // Left apex: leftmost X, moving downward (+Z -> heading +PI/2)
      if (curr.segment === 'left-turn' && Math.abs(curr.z - DEFAULT_TRACK_CONFIG.centerZ) < 0.25) {
        sawLeftApex = true;
        assert.ok(curr.x < DEFAULT_TRACK_CONFIG.centerX - DEFAULT_TRACK_CONFIG.halfStraight);
        assert.ok(curr.tangentZ > 0.9, 'Left turn must move counter-clockwise (+Z)');
        const deg = (curr.bankAngleRad * 180) / Math.PI;
        assert.ok(Math.abs(deg - DEFAULT_TRACK_CONFIG.maxBankAngleDeg) < 0.5);
      }

      prev = curr;
    }

    assert.equal(sawRightApex, true);
    assert.equal(sawTopStraight, true);
    assert.equal(sawLeftApex, true);
  });

  it('assigns distinct radial lane offsets so riders at equal progress do not overlap', () => {
    const offsets = [0, 1, 2, 3].map((i) => computeLaneOffset(i, 4));
    for (let i = 1; i < offsets.length; i++) {
      assert.ok(offsets[i] > offsets[i - 1], 'Lane offsets must strictly increase outward');
    }

    const pInner = evaluateTrackPose(0.25, offsets[0]);
    const pOuter = evaluateTrackPose(0.25, offsets[3]);
    const separation = Math.hypot(pOuter.x - pInner.x, pOuter.z - pInner.z);
    assert.ok(separation > 0.4, `Expected radial separation > 0.4, got ${separation}`);

    // Single rider centers on laneOffset = 0
    assert.equal(computeLaneOffset(0, 1), 0);
  });

  it('assigns deterministic lanes by userId regardless of input standing order', () => {
    const a = makeStanding({ userId: 'u-alpha', displayName: 'Alpha', dailyScores: [] });
    const b = makeStanding({ userId: 'u-beta', displayName: 'Beta', dailyScores: [] });

    const lanes1 = assignDeterministicLanes([a, b]);
    const lanes2 = assignDeterministicLanes([b, a]);

    assert.deepEqual(lanes1.get('u-alpha'), lanes2.get('u-alpha'));
    assert.deepEqual(lanes1.get('u-beta'), lanes2.get('u-beta'));
  });
});

describe('multi-day race timeline interpolation', () => {
  it('animates daily view from 0 to weightedScorePct / 100 laps with overdrive > 1.0', () => {
    const race: RaceResponse = {
      group: { groupId: 'g1', name: 'Club', inviteCode: 'ABC123' },
      range: 'daily',
      date: '2026-11-24',
      startDate: '2026-11-24',
      endDate: '2026-11-24',
      generatedAt: '2026-11-24T15:00:00Z',
      standings: [
        makeStanding({
          userId: 'u1',
          displayName: 'Alex',
          rank: 1,
          dailyScores: [{ date: '2026-11-24', pct: 110 }],
        }),
        makeStanding({
          userId: 'u2',
          displayName: 'Sam',
          rank: 2,
          dailyScores: [{ date: '2026-11-24', pct: 60 }],
        }),
      ],
    };

    const timeline = buildRaceTimeline(race, { todayIso: '2026-11-24' });
    assert.equal(timeline.activeSegmentCount, 1);

    const start = sampleRaceTimeline(timeline, 0);
    assert.equal(start.riders[0].laps, 0);
    assert.equal(start.riders[0].velocity, 0);

    const mid = sampleRaceTimeline(timeline, 0.5);
    assert.ok(Math.abs(mid.riders[0].laps - 0.55) < 1e-6);
    assert.ok(mid.riders[0].velocity > mid.riders[1].velocity);

    const end = sampleRaceTimeline(timeline, 1);
    assert.ok(Math.abs(end.riders[0].laps - 1.1) < 1e-6);
    assert.equal(end.riders[0].isOverdrive, true);
    assert.equal(end.riders[0].isLiveLeader, true);
    assert.ok(Math.abs(end.riders[1].laps - 0.6) < 1e-6);
    assert.equal(end.riders[1].isOverdrive, false);
  });

  it('animates weekly Mon 110% -> Tue 80% with cumulative laps, speed change, overtakes, and upcoming day cutoff', () => {
    const weekDates = [
      '2026-11-23', // Mon
      '2026-11-24', // Tue
      '2026-11-25', // Wed (future when today = Tue)
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
      '2026-11-29',
    ];

    // Rider A: 110% Mon (1.10 laps), 80% Tue (1.90 laps cumulative)
    // Rider B: 70% Mon (0.70 laps), 150% Tue (2.20 laps cumulative -> overtakes Rider A on Tuesday!)
    const race: RaceResponse = {
      group: { groupId: 'g1', name: 'Velodrome', inviteCode: 'VELO' },
      range: 'weekly',
      date: '2026-11-24',
      startDate: '2026-11-23',
      endDate: '2026-11-29',
      generatedAt: '2026-11-24T18:00:00Z',
      standings: [
        makeStanding({
          userId: 'rider-b',
          displayName: 'Rider B',
          rank: 1,
          dailyScores: weekDates.map((date, i) => ({
            date,
            pct: i === 0 ? 70 : i === 1 ? 150 : 0,
          })),
        }),
        makeStanding({
          userId: 'rider-a',
          displayName: 'Rider A',
          rank: 2,
          dailyScores: weekDates.map((date, i) => ({
            date,
            pct: i === 0 ? 110 : i === 1 ? 80 : 0,
          })),
        }),
      ],
    };

    // Viewing current week on Tuesday 2026-11-24 -> 2 active segments, 5 upcoming
    const timeline = buildRaceTimeline(race, { todayIso: '2026-11-24' });
    assert.equal(timeline.activeSegmentCount, 2);
    assert.equal(timeline.days.length, 7);
    assert.equal(timeline.days[0].isUpcoming, false);
    assert.equal(timeline.days[1].isUpcoming, false);
    assert.equal(timeline.days[2].isUpcoming, true);

    // End of Monday (t = 1.0): Rider A is at 1.10 laps (leading), Rider B is at 0.70 laps
    const endMon = sampleRaceTimeline(timeline, 1.0);
    const aMon = endMon.riders.find((r) => r.userId === 'rider-a')!;
    const bMon = endMon.riders.find((r) => r.userId === 'rider-b')!;
    assert.ok(Math.abs(aMon.laps - 1.1) < 1e-6);
    assert.ok(Math.abs(bMon.laps - 0.7) < 1e-6);
    assert.equal(aMon.liveRank, 1);
    assert.equal(aMon.isLiveLeader, true);
    assert.equal(bMon.liveRank, 2);

    // Mid-Monday vs Mid-Tuesday speed check for Rider A (110% Mon faster than 80% Tue)
    const midMon = sampleRaceTimeline(timeline, 0.5);
    const midTue = sampleRaceTimeline(timeline, 1.5);
    const aMidMon = midMon.riders.find((r) => r.userId === 'rider-a')!;
    const aMidTue = midTue.riders.find((r) => r.userId === 'rider-a')!;
    assert.ok(
      aMidMon.velocity > aMidTue.velocity,
      `Expected Mon 110% velocity (${aMidMon.velocity}) > Tue 80% velocity (${aMidTue.velocity})`,
    );

    // End of Tuesday (t = 2.0): Rider A at 1.90 laps, Rider B overtakes to 2.20 laps
    const endTue = sampleRaceTimeline(timeline, 2.0);
    const aTue = endTue.riders.find((r) => r.userId === 'rider-a')!;
    const bTue = endTue.riders.find((r) => r.userId === 'rider-b')!;
    assert.ok(Math.abs(aTue.laps - 1.9) < 1e-6);
    assert.ok(Math.abs(bTue.laps - 2.2) < 1e-6);
    assert.equal(bTue.liveRank, 1);
    assert.equal(bTue.isLiveLeader, true);
    assert.equal(aTue.liveRank, 2);
  });

  it('never rolls backward when a high-activity day is followed by a 0% rest day', () => {
    const weekDates = [
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
      '2026-11-29',
    ];
    const race: RaceResponse = {
      group: { groupId: 'g1', name: 'Test', inviteCode: 'TEST' },
      range: 'weekly',
      date: '2026-11-29',
      startDate: '2026-11-23',
      endDate: '2026-11-29',
      generatedAt: '2026-11-29T20:00:00Z',
      standings: [
        makeStanding({
          userId: 'u1',
          displayName: 'Sprinter',
          dailyScores: weekDates.map((date, i) => ({
            date,
            pct: i === 0 ? 180 : i === 1 ? 0 : i === 2 ? 140 : 0,
          })),
        }),
      ],
    };

    // Past week -> all 7 days active
    const timeline = buildRaceTimeline(race, { todayIso: '2026-12-01' });
    assert.equal(timeline.activeSegmentCount, 7);

    let prevLaps = 0;
    for (let step = 0; step <= 140; step++) {
      const t = (step / 140) * 7;
      const frame = sampleRaceTimeline(timeline, t);
      const curr = frame.riders[0].laps;
      assert.ok(curr >= prevLaps - 1e-9, `Rider rolled backward at t=${t}: ${curr} < ${prevLaps}`);
      assert.ok(frame.riders[0].velocity >= 0);
      prevLaps = curr;
    }
    assert.ok(Math.abs(prevLaps - 3.2) < 1e-6);
  });

  it('produces identical data signatures across polling refreshes when scores have not changed', () => {
    const base: RaceResponse = {
      group: { groupId: 'g1', name: 'Club', inviteCode: 'ABC' },
      range: 'daily',
      date: '2026-11-24',
      startDate: '2026-11-24',
      endDate: '2026-11-24',
      generatedAt: '2026-11-24T12:00:00Z',
      standings: [
        makeStanding({
          userId: 'u1',
          displayName: 'Alex',
          dailyScores: [{ date: '2026-11-24', pct: 90 }],
        }),
      ],
    };

    const pollSame: RaceResponse = {
      ...base,
      generatedAt: '2026-11-24T12:00:30Z',
    };

    const pollUpdated: RaceResponse = {
      ...base,
      generatedAt: '2026-11-24T12:01:00Z',
      standings: [
        makeStanding({
          userId: 'u1',
          displayName: 'Alex',
          dailyScores: [{ date: '2026-11-24', pct: 95 }],
        }),
      ],
    };

    assert.equal(computeRaceIdentity(base), computeRaceIdentity(pollSame));
    assert.equal(computeRaceDataSignature(base), computeRaceDataSignature(pollSame));
    assert.notEqual(computeRaceDataSignature(base), computeRaceDataSignature(pollUpdated));
  });
});
