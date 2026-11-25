import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getTodayIsoDate, type RaceRange } from '@activity-racer/shared';
import { useGroups, useRace } from '../api/queries';
import { PlaybackControls, type PlaybackSpeed } from '../components/PlaybackControls';
import type { CameraMode } from '../components/VelodromeRace3D';
import {
  buildRaceTimeline,
  computeRaceDataSignature,
  computeRaceIdentity,
  sampleRaceTimeline,
} from '../race/trackMath';

const VelodromeRace3D = lazy(() => import('../components/VelodromeRace3D'));

function formatTime(timestamp: number | string | null): string {
  if (!timestamp) {
    return 'No sync yet';
  }
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function RacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [range, setRange] = useState<RaceRange>('daily');
  const [date, setDate] = useState<string>(() => getTodayIsoDate());
  const [cameraMode, setCameraMode] = useState<CameraMode>('stadium');
  const [showLabels, setShowLabels] = useState<boolean>(true);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [uiTimelineT, setUiTimelineT] = useState<number>(0);

  // Refs shared with the 60fps Three.js render loop to avoid per-frame React re-renders
  const timelineTRef = useRef<number>(0);
  const isPlayingRef = useRef<boolean>(false);
  const speedRef = useRef<PlaybackSpeed>(1);
  const lastRaceIdentityRef = useRef<string | null>(null);
  const lastDataSignatureRef = useRef<string | null>(null);

  isPlayingRef.current = isPlaying;
  speedRef.current = speed;

  const groupsQuery = useGroups();
  const groups = groupsQuery.data?.groups ?? [];

  const paramGroupId = searchParams.get('group') ?? undefined;
  const activeGroupId =
    groups.find((g) => g.groupId === paramGroupId)?.groupId ?? groups[0]?.groupId;

  useEffect(() => {
    if (activeGroupId && activeGroupId !== paramGroupId) {
      setSearchParams({ group: activeGroupId }, { replace: true });
    }
  }, [activeGroupId, paramGroupId, setSearchParams]);

  const raceQuery = useRace(activeGroupId, range, date);
  const raceData = raceQuery.data;

  // Build stable timeline only when actual race scores/structure change (polling-safe)
  const raceIdentity = raceData ? computeRaceIdentity(raceData) : null;
  const raceSignature = raceData ? computeRaceDataSignature(raceData) : null;

  const timeline = useMemo(() => {
    if (!raceData) {
      return null;
    }
    return buildRaceTimeline(raceData);
    // Recompute only when raceSignature changes so identical 30s polls preserve object identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raceSignature]);

  // Reset playback ONLY when switching group/range/date window; preserve cursor on identical polls
  useEffect(() => {
    if (!timeline || !raceIdentity || !raceSignature) {
      return;
    }

    const identityChanged = lastRaceIdentityRef.current !== raceIdentity;
    lastRaceIdentityRef.current = raceIdentity;
    lastDataSignatureRef.current = raceSignature;

    if (identityChanged) {
      if (prefersReducedMotion()) {
        timelineTRef.current = timeline.activeSegmentCount;
        setUiTimelineT(timeline.activeSegmentCount);
        setIsPlaying(false);
      } else {
        timelineTRef.current = 0;
        setUiTimelineT(0);
        setIsPlaying(true);
      }
      return;
    }

    // Same race view: clamp cursor smoothly if active segment count changed
    if (timelineTRef.current > timeline.activeSegmentCount) {
      timelineTRef.current = timeline.activeSegmentCount;
      setUiTimelineT(timeline.activeSegmentCount);
    }
  }, [timeline, raceIdentity, raceSignature]);

  // Drive playback clock smoothly; throttle React HUD/scrubber updates to ~20 Hz
  useEffect(() => {
    if (!timeline || !isPlaying) {
      return;
    }

    let rafId: number | null = null;
    let lastMs = performance.now();
    let lastUiSyncMs = lastMs;
    const maxT = timeline.activeSegmentCount;
    const secPerSeg = timeline.secondsPerSegment;

    const tick = (nowMs: number) => {
      rafId = null;
      if (document.visibilityState === 'hidden') {
        return;
      }

      const dtSec = Math.min(0.1, Math.max(0, (nowMs - lastMs) / 1000));
      lastMs = nowMs;

      const deltaT = (dtSec * speedRef.current) / secPerSeg;
      const nextT = Math.min(maxT, timelineTRef.current + deltaT);
      timelineTRef.current = nextT;

      if (nextT >= maxT) {
        setUiTimelineT(maxT);
        setIsPlaying(false);
        return;
      }

      if (nowMs - lastUiSyncMs >= 50) {
        lastUiSyncMs = nowMs;
        setUiTimelineT(nextT);
      }

      rafId = window.requestAnimationFrame(tick);
    };

    const resumeIfVisible = () => {
      if (document.visibilityState === 'hidden') {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
      } else if (rafId === null) {
        lastMs = performance.now();
        rafId = window.requestAnimationFrame(tick);
      }
    };

    document.addEventListener('visibilitychange', resumeIfVisible);
    rafId = window.requestAnimationFrame(tick);

    return () => {
      document.removeEventListener('visibilitychange', resumeIfVisible);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [timeline, isPlaying]);

  const handleGroupChange = (nextGroupId: string) => {
    setSearchParams({ group: nextGroupId });
  };

  const handleTogglePlay = useCallback(() => {
    if (!timeline) return;
    setIsPlaying((prev) => {
      if (prev) {
        return false;
      }
      if (timelineTRef.current >= timeline.activeSegmentCount - 0.001) {
        timelineTRef.current = 0;
        setUiTimelineT(0);
      }
      return true;
    });
  }, [timeline]);

  const handleReplay = useCallback(() => {
    if (!timeline) return;
    timelineTRef.current = 0;
    setUiTimelineT(0);
    setIsPlaying(true);
  }, [timeline]);

  const handleSkipToFinish = useCallback(() => {
    if (!timeline) return;
    timelineTRef.current = timeline.activeSegmentCount;
    setUiTimelineT(timeline.activeSegmentCount);
    setIsPlaying(false);
  }, [timeline]);

  const handleScrub = useCallback(
    (nextT: number) => {
      if (!timeline) return;
      const clamped = Math.max(0, Math.min(timeline.activeSegmentCount, nextT));
      timelineTRef.current = clamped;
      setUiTimelineT(clamped);
    },
    [timeline],
  );

  const uiFrame = useMemo(() => {
    if (!timeline) {
      return null;
    }
    return sampleRaceTimeline(timeline, uiTimelineT);
  }, [timeline, uiTimelineT]);

  const hasCurrentUser = Boolean(raceData?.standings.some((s) => s.isCurrentUser));

  return (
    <div className="page-stack">
      <div className="page-header">
        <div>
          <h1>Live Velodrome Race</h1>
          <p className="subtitle">
            3D animated velodrome replay synced to daily &amp; weekly weighted activity scores.
          </p>
        </div>
        {raceData && (
          <div className="refresh-meta">
            <span className="muted small">
              Auto-polling every 30s · Updated {formatTime(raceQuery.dataUpdatedAt)}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={raceQuery.isFetching}
              onClick={() => void raceQuery.refetch()}
            >
              {raceQuery.isFetching ? 'Refreshing...' : 'Refresh Now'}
            </button>
          </div>
        )}
      </div>

      {groupsQuery.isPending && (
        <div className="card">
          <p className="muted">Loading your racing groups...</p>
        </div>
      )}

      {groupsQuery.isError && (
        <div className="alert alert-error">
          {groupsQuery.error instanceof Error
            ? groupsQuery.error.message
            : 'Unable to load groups.'}
        </div>
      )}

      {groupsQuery.isSuccess && groups.length === 0 && (
        <section className="card empty-state">
          <h2>No Racing Groups Yet</h2>
          <p className="muted">
            Create a group or join one with an invite code to start racing against friends &amp;
            family.
          </p>
          <Link to="/groups" className="btn btn-primary">
            Go to Groups
          </Link>
        </section>
      )}

      {groups.length > 0 && (
        <>
          <section className="card controls-bar">
            <label className="control-field">
              <span>Group</span>
              <select
                value={activeGroupId ?? ''}
                onChange={(e) => handleGroupChange(e.target.value)}
              >
                {groups.map((g) => (
                  <option key={g.groupId} value={g.groupId}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="control-field">
              <span>Range</span>
              <div className="segmented" role="group" aria-label="Race time range">
                <button
                  type="button"
                  className={range === 'daily' ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => setRange('daily')}
                >
                  Daily
                </button>
                <button
                  type="button"
                  className={range === 'weekly' ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => setRange('weekly')}
                >
                  Weekly (Mon–Sun)
                </button>
              </div>
            </div>

            <div className="control-field">
              <span>Date</span>
              <div className="date-row">
                <input
                  type="date"
                  value={date}
                  onChange={(e) => {
                    if (e.target.value) {
                      setDate(e.target.value);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setDate(getTodayIsoDate())}
                >
                  Today
                </button>
              </div>
            </div>
          </section>

          {raceQuery.isPending && (
            <section className="card">
              <p className="muted">Loading race track &amp; standings...</p>
            </section>
          )}

          {raceQuery.isError && (
            <section className="card">
              <div className="alert alert-error">
                {raceQuery.error instanceof Error
                  ? raceQuery.error.message
                  : 'Failed to load race standings.'}
              </div>
            </section>
          )}

          {raceData && timeline && uiFrame && (
            <>
              <section className="card velodrome-card">
                <div className="section-head">
                  <div>
                    <h2>{raceData.group.name}</h2>
                    <p className="muted small">
                      {raceData.range === 'weekly'
                        ? `Week of ${raceData.startDate} to ${raceData.endDate}`
                        : `Daily race for ${raceData.date}`}
                      {' · Invite code: '}
                      <code className="code-inline">{raceData.group.inviteCode}</code>
                    </p>
                  </div>
                </div>

                <Suspense
                  fallback={
                    <div className="velodrome-loading">
                      <div className="spinner" aria-hidden="true" />
                      <p className="muted small">Loading 3D Velodrome...</p>
                    </div>
                  }
                >
                  <VelodromeRace3D
                    timeline={timeline}
                    timelineTRef={timelineTRef}
                    isPlayingRef={isPlayingRef}
                    speedRef={speedRef}
                    cameraMode={cameraMode}
                    showLabels={showLabels}
                    hasCurrentUser={hasCurrentUser}
                    onCameraModeChange={setCameraMode}
                    onToggleLabels={() => setShowLabels((v) => !v)}
                  />
                </Suspense>

                <PlaybackControls
                  timeline={timeline}
                  frame={uiFrame}
                  isPlaying={isPlaying}
                  speed={speed}
                  onTogglePlay={handleTogglePlay}
                  onReplay={handleReplay}
                  onSkipToFinish={handleSkipToFinish}
                  onSpeedChange={setSpeed}
                  onScrub={handleScrub}
                />
              </section>

              <section className="card">
                <div className="section-head">
                  <h3>Standings</h3>
                  <span className="muted small">
                    {raceData.standings.length}{' '}
                    {raceData.standings.length === 1 ? 'racer' : 'racers'}
                  </span>
                </div>

                <div className="table-wrap">
                  <table className="race-table">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Racer</th>
                        <th>Weighted Score</th>
                        <th>Steps</th>
                        <th>Active Calories</th>
                        <th>Last Sync</th>
                      </tr>
                    </thead>
                    <tbody>
                      {raceData.standings.map((row) => (
                        <tr
                          key={row.userId}
                          className={row.isCurrentUser ? 'row-current-user' : undefined}
                        >
                          <td>
                            <span className="rank-num">#{row.rank}</span>
                            {row.isLeader && <span className="pill pill-gold">Leader</span>}
                          </td>
                          <td>
                            <div className="racer-cell">
                              <span
                                className="color-dot"
                                style={{ backgroundColor: row.bikeColor }}
                                aria-hidden="true"
                              />
                              <div>
                                <div className="racer-name">
                                  <strong>{row.displayName}</strong>
                                  {row.isCurrentUser && <span className="pill pill-blue">You</span>}
                                </div>
                                <span className="muted small">@{row.playerSlug}</span>
                              </div>
                            </div>
                          </td>
                          <td>
                            <div className="score-cell">
                              <strong>{row.weightedScorePct.toFixed(1)}%</strong>
                              {row.isOverdrive && (
                                <span className="pill pill-overdrive">OVERDRIVE</span>
                              )}
                            </div>
                            <div className="mini-bar" aria-hidden="true">
                              <div
                                className="mini-bar-fill"
                                style={{
                                  width: `${Math.min(100, Math.max(0, row.weightedScorePct))}%`,
                                  backgroundColor: row.bikeColor,
                                }}
                              />
                            </div>
                          </td>
                          <td>
                            <div>
                              <strong>{row.steps.toLocaleString()}</strong>{' '}
                              <span className="muted small">
                                / {row.stepTarget.toLocaleString()}
                              </span>
                            </div>
                            <span className="muted small">{row.stepPct.toFixed(1)}%</span>
                          </td>
                          <td>
                            <div>
                              <strong>{row.activeCalories.toLocaleString()}</strong>{' '}
                              <span className="muted small">
                                / {row.calorieTarget.toLocaleString()} kcal
                              </span>
                            </div>
                            <span className="muted small">{row.caloriePct.toFixed(1)}%</span>
                          </td>
                          <td className="muted small">{formatTime(row.lastUpdatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
