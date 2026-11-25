import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  getTodayIsoDate,
  isValidIsoDate,
  type RaceRange,
  type RaceStanding,
} from '@activity-racer/shared';
import { useGroups, useRace, useRaceCommentary } from '../api/queries';
import {
  ChevronDownIcon,
  FlameIcon,
  RefreshIcon,
  StepsIcon,
  TrophyIcon,
} from '../components/Icons';
import {
  PLAYBACK_SPEEDS,
  PlaybackControls,
  type PlaybackSpeed,
} from '../components/PlaybackControls';
import {
  RaceCommentaryTicker,
  buildCommentarySpeakKey,
} from '../components/RaceCommentaryTicker';
import type { CameraMode } from '../components/VelodromeRace3D';
import {
  buildRaceTimeline,
  computeRaceDataSignature,
  computeRaceIdentity,
  formatDayLabels,
  sampleRaceTimeline,
  type RaceTimeline,
} from '../race/trackMath';
import { cancelSpeech, speakText } from '../race/tts';

const VelodromeRace3D = lazy(() => import('../components/VelodromeRace3D'));

function formatTime(timestamp: number | string | null): string {
  if (!timestamp) {
    return 'No sync yet';
  }
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const PLAYBACK_PREFS_STORAGE_KEY = 'activity-racer:playback-prefs';
const VALID_CAMERA_MODES: readonly CameraMode[] = ['stadium', 'top', 'leader', 'me'];
const VALID_RANGES: readonly RaceRange[] = ['daily', 'weekly'];

type DateSelectionMode = 'today' | 'custom';

interface PlaybackPreferences {
  groupId: string | null;
  range: RaceRange;
  dateMode: DateSelectionMode;
  customDate: string | null;
  cameraMode: CameraMode;
  showLabels: boolean;
  speed: PlaybackSpeed;
  commentaryEnabled: boolean;
  ttsEnabled: boolean;
  ttsVoiceUri: string | null;
}

const DEFAULT_PLAYBACK_PREFS: PlaybackPreferences = {
  groupId: null,
  range: 'daily',
  dateMode: 'today',
  customDate: null,
  cameraMode: 'stadium',
  showLabels: true,
  speed: 1,
  commentaryEnabled: true,
  ttsEnabled: false,
  ttsVoiceUri: null,
};

function loadPlaybackPreferences(): PlaybackPreferences {
  if (typeof window === 'undefined') {
    return DEFAULT_PLAYBACK_PREFS;
  }
  try {
    const raw = window.localStorage.getItem(PLAYBACK_PREFS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_PLAYBACK_PREFS;
    }
    const parsed = JSON.parse(raw) as Partial<Record<keyof PlaybackPreferences, unknown>>;
    const groupId =
      typeof parsed.groupId === 'string' && parsed.groupId.trim().length > 0
        ? parsed.groupId.trim()
        : null;
    const range = VALID_RANGES.includes(parsed.range as RaceRange)
      ? (parsed.range as RaceRange)
      : DEFAULT_PLAYBACK_PREFS.range;
    const rawCustomDate =
      typeof parsed.customDate === 'string' && isValidIsoDate(parsed.customDate)
        ? parsed.customDate
        : null;
    const dateMode: DateSelectionMode =
      parsed.dateMode === 'custom' && rawCustomDate ? 'custom' : 'today';
    const cameraMode = VALID_CAMERA_MODES.includes(parsed.cameraMode as CameraMode)
      ? (parsed.cameraMode as CameraMode)
      : DEFAULT_PLAYBACK_PREFS.cameraMode;
    const showLabels =
      typeof parsed.showLabels === 'boolean'
        ? parsed.showLabels
        : DEFAULT_PLAYBACK_PREFS.showLabels;
    const speed = PLAYBACK_SPEEDS.includes(parsed.speed as PlaybackSpeed)
      ? (parsed.speed as PlaybackSpeed)
      : DEFAULT_PLAYBACK_PREFS.speed;
    const commentaryEnabled =
      typeof parsed.commentaryEnabled === 'boolean'
        ? parsed.commentaryEnabled
        : DEFAULT_PLAYBACK_PREFS.commentaryEnabled;
    const ttsEnabled =
      typeof parsed.ttsEnabled === 'boolean'
        ? parsed.ttsEnabled
        : DEFAULT_PLAYBACK_PREFS.ttsEnabled;
    const ttsVoiceUri =
      typeof parsed.ttsVoiceUri === 'string' && parsed.ttsVoiceUri.trim().length > 0
        ? parsed.ttsVoiceUri
        : null;
    return {
      groupId,
      range,
      dateMode,
      customDate: dateMode === 'custom' ? rawCustomDate : null,
      cameraMode,
      showLabels,
      speed,
      commentaryEnabled,
      ttsEnabled,
      ttsVoiceUri,
    };
  } catch {
    return DEFAULT_PLAYBACK_PREFS;
  }
}

function savePlaybackPreferences(prefs: PlaybackPreferences): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(PLAYBACK_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota or private-browsing write errors
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface RiderBreakdownPanelProps {
  row: RaceStanding;
  range: RaceRange;
  timeline: RaceTimeline;
  activeDayIndex: number;
  onJumpToDay: (dayIndex: number) => void;
}

function RiderBreakdownPanel({
  row,
  range,
  timeline,
  activeDayIndex,
  onJumpToDay,
}: RiderBreakdownPanelProps) {
  const stepWeightPct = Math.round(row.stepWeight * 100);
  const calWeightPct = Math.round(row.calorieWeight * 100);
  const dailyStepTarget = range === 'weekly' ? Math.round(row.stepTarget / 7) : row.stepTarget;
  const dailyCalTarget = range === 'weekly' ? Math.round(row.calorieTarget / 7) : row.calorieTarget;

  const stepWeightedContrib = row.stepWeight * row.stepPct;
  const calWeightedContrib = row.calorieWeight * row.caloriePct;

  return (
    <div className="breakdown-panel">
      {/* Personal formula & metadata */}
      <div className="breakdown-formula-row">
        <span className="breakdown-formula-text">
          <strong>Target formula:</strong>{' '}
          {stepWeightPct}% × Steps / {dailyStepTarget.toLocaleString()}
          {' + '}
          {calWeightPct}% × Cal / {dailyCalTarget.toLocaleString()} kcal
          {range === 'weekly' && ' (÷ 7 days)'}
        </span>
        <span className="breakdown-sync-meta muted small">
          {range === 'weekly' && `${row.daysLogged}/7 days logged · `}
          Sync: {formatTime(row.lastUpdatedAt)}
        </span>
      </div>

      {/* Raw vs. normalized progress metrics */}
      <div className="breakdown-metrics-grid">
        <div className="breakdown-metric-card">
          <div className="breakdown-metric-head">
            <span className="breakdown-metric-title">
              <StepsIcon size={15} />
              <span>Steps</span>
            </span>
            <span className="breakdown-metric-pct">
              <strong>{row.stepPct.toFixed(1)}%</strong>
              <span className="muted small"> (+{stepWeightedContrib.toFixed(1)} wt)</span>
            </span>
          </div>
          <div className="breakdown-metric-raw">
            <strong>{row.steps.toLocaleString()}</strong>
            <span className="muted small"> / {row.stepTarget.toLocaleString()}</span>
          </div>
          <div className="breakdown-bar-track" aria-hidden="true">
            <div
              className={`breakdown-bar-fill${row.stepPct > 100 ? ' overdrive' : ''}`}
              style={{
                width: `${Math.min(100, Math.max(0, row.stepPct))}%`,
                backgroundColor: row.stepPct > 100 ? undefined : row.bikeColor,
              }}
            />
          </div>
        </div>

        <div className="breakdown-metric-card">
          <div className="breakdown-metric-head">
            <span className="breakdown-metric-title">
              <FlameIcon size={15} />
              <span>Active Calories</span>
            </span>
            <span className="breakdown-metric-pct">
              <strong>{row.caloriePct.toFixed(1)}%</strong>
              <span className="muted small"> (+{calWeightedContrib.toFixed(1)} wt)</span>
            </span>
          </div>
          <div className="breakdown-metric-raw">
            <strong>{row.activeCalories.toLocaleString()}</strong>
            <span className="muted small"> / {row.calorieTarget.toLocaleString()} kcal</span>
          </div>
          <div className="breakdown-bar-track" aria-hidden="true">
            <div
              className={`breakdown-bar-fill${row.caloriePct > 100 ? ' overdrive' : ''}`}
              style={{
                width: `${Math.min(100, Math.max(0, row.caloriePct))}%`,
                backgroundColor: row.caloriePct > 100 ? undefined : row.bikeColor,
              }}
            />
          </div>
        </div>
      </div>

      {/* 7-day Mon-Sun mini bar chart in Weekly mode (click a day to jump the 3D replay) */}
      {range === 'weekly' && row.dailyBreakdown.length > 0 && (
        <div className="weekly-bars-section">
          <div className="weekly-bars-header">
            <span className="small">
              <strong>Mon–Sun Daily Pace</strong>
            </span>
            <span className="muted small">Tap a day to jump replay · Dashed line = 100%</span>
          </div>

          <div className="weekly-bars-grid">
            {row.dailyBreakdown.map((day, idx) => {
              const timelineDay = timeline.days[idx];
              const isUpcoming = timelineDay?.isUpcoming ?? false;
              const isActive = !isUpcoming && idx === activeDayIndex;
              const { shortLabel } = formatDayLabels(day.date);
              // Scale chart height up to 150% so 100% sits cleanly at 66.7% height
              const heightPct = Math.min(100, Math.max(0, (day.weightedScorePct / 150) * 100));

              return (
                <button
                  key={day.date}
                  type="button"
                  disabled={isUpcoming}
                  className={`weekly-bar-col${isActive ? ' active' : ''}${
                    isUpcoming ? ' upcoming' : ''
                  }${day.isOverdrive ? ' overdrive' : ''}`}
                  title={`${shortLabel} (${day.date}): ${day.weightedScorePct.toFixed(1)}% · ${day.steps.toLocaleString()} steps · ${day.activeCalories.toLocaleString()} kcal`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isUpcoming) {
                      onJumpToDay(idx);
                    }
                  }}
                >
                  <span className="weekly-bar-pct">
                    {isUpcoming ? '—' : `${Math.round(day.weightedScorePct)}%`}
                  </span>
                  <div className="weekly-bar-well" aria-hidden="true">
                    <span className="weekly-bar-target-line" />
                    <div
                      className={`weekly-bar-stick${day.isOverdrive ? ' overdrive' : ''}`}
                      style={{
                        height: `${heightPct}%`,
                        backgroundColor: day.isOverdrive ? undefined : row.bikeColor,
                      }}
                    />
                  </div>
                  <span className="weekly-bar-day">{shortLabel}</span>
                  <span className="weekly-bar-raw">
                    {day.steps > 0 ? `${(day.steps / 1000).toFixed(1)}k` : '0'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function RacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialPrefs = useMemo(() => loadPlaybackPreferences(), []);
  const [savedGroupId, setSavedGroupId] = useState<string | null>(initialPrefs.groupId);
  const [range, setRange] = useState<RaceRange>(initialPrefs.range);
  const [dateMode, setDateMode] = useState<DateSelectionMode>(initialPrefs.dateMode);
  const [date, setDate] = useState<string>(() =>
    initialPrefs.dateMode === 'custom' && initialPrefs.customDate
      ? initialPrefs.customDate
      : getTodayIsoDate(),
  );
  const [cameraMode, setCameraMode] = useState<CameraMode>(initialPrefs.cameraMode);
  const [showLabels, setShowLabels] = useState<boolean>(initialPrefs.showLabels);
  const [speed, setSpeed] = useState<PlaybackSpeed>(initialPrefs.speed);
  const [commentaryEnabled, setCommentaryEnabled] = useState<boolean>(
    initialPrefs.commentaryEnabled,
  );
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(initialPrefs.ttsEnabled);
  const [ttsVoiceUri, setTtsVoiceUri] = useState<string | null>(initialPrefs.ttsVoiceUri);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [uiTimelineT, setUiTimelineT] = useState<number>(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  // Persist user's filter, playback, camera, and announcer/voice preferences across reloads
  useEffect(() => {
    savePlaybackPreferences({
      groupId: savedGroupId,
      range,
      dateMode,
      customDate: dateMode === 'custom' ? date : null,
      cameraMode,
      showLabels,
      speed,
      commentaryEnabled,
      ttsEnabled,
      ttsVoiceUri,
    });
  }, [
    savedGroupId,
    range,
    dateMode,
    date,
    cameraMode,
    showLabels,
    speed,
    commentaryEnabled,
    ttsEnabled,
    ttsVoiceUri,
  ]);

  // Refs shared with the 60fps Three.js render loop to avoid per-frame React re-renders
  const timelineTRef = useRef<number>(0);
  const isPlayingRef = useRef<boolean>(false);
  const speedRef = useRef<PlaybackSpeed>(initialPrefs.speed);
  const lastRaceIdentityRef = useRef<string | null>(null);
  const lastDataSignatureRef = useRef<string | null>(null);
  const lastSpokenKeyRef = useRef<string | null>(null);

  isPlayingRef.current = isPlaying;
  speedRef.current = speed;

  const groupsQuery = useGroups();
  const groups = groupsQuery.data?.groups ?? [];

  const paramGroupId = searchParams.get('group') ?? undefined;
  const activeGroupId =
    groups.find((g) => g.groupId === paramGroupId)?.groupId ??
    groups.find((g) => g.groupId === savedGroupId)?.groupId ??
    groups[0]?.groupId;

  useEffect(() => {
    if (activeGroupId && activeGroupId !== paramGroupId) {
      setSearchParams({ group: activeGroupId }, { replace: true });
    }
    if (activeGroupId && activeGroupId !== savedGroupId) {
      setSavedGroupId(activeGroupId);
    }
  }, [activeGroupId, paramGroupId, savedGroupId, setSearchParams]);

  const raceQuery = useRace(activeGroupId, range, date);
  const raceData = raceQuery.data;

  const commentaryQuery = useRaceCommentary(
    activeGroupId,
    range,
    date,
    raceData?.startDate,
    commentaryEnabled && Boolean(raceData),
  );

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

  // Reset riders cleanly to starting line on race change (no auto-play so the user's Play click unlocks browser TTS)
  useEffect(() => {
    if (!timeline || !raceIdentity || !raceSignature) {
      return;
    }

    const identityChanged = lastRaceIdentityRef.current !== raceIdentity;
    lastRaceIdentityRef.current = raceIdentity;
    lastDataSignatureRef.current = raceSignature;

    if (identityChanged) {
      cancelSpeech();
      lastSpokenKeyRef.current = null;
      if (prefersReducedMotion()) {
        timelineTRef.current = timeline.activeSegmentCount;
        setUiTimelineT(timeline.activeSegmentCount);
      } else {
        timelineTRef.current = 0;
        setUiTimelineT(0);
      }
      setIsPlaying(false);
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
    setSavedGroupId(nextGroupId);
    setSearchParams({ group: nextGroupId });
  };

  /**
   * Synchronously triggers or unlocks browser speechSynthesis inside the user's click/tap
   * gesture so Chrome/Safari/iOS play audio on the very first click without toggling TTS.
   */
  const unlockAndSpeakForT = useCallback(
    (targetT: number) => {
      if (!commentaryEnabled || !ttsEnabled || !timeline) {
        return;
      }
      const targetFrame = sampleRaceTimeline(timeline, targetT);
      const entry =
        commentaryQuery.data?.days.find((d) => d.date === targetFrame.activeDay.date) ??
        commentaryQuery.data?.days[commentaryQuery.data.days.length - 1];

      if (entry?.commentary) {
        lastSpokenKeyRef.current = buildCommentarySpeakKey(
          commentaryQuery.data?.generatedAt,
          entry.date,
          entry.commentary,
        );
        speakText(entry.commentary, ttsVoiceUri);
      } else {
        // Warm up speechSynthesis inside the user gesture while commentary finishes loading
        speakText(' ', ttsVoiceUri);
      }
    },
    [commentaryEnabled, ttsEnabled, timeline, commentaryQuery.data, ttsVoiceUri],
  );

  const handleTogglePlay = useCallback(() => {
    if (!timeline) return;
    if (isPlaying) {
      cancelSpeech();
      setIsPlaying(false);
      return;
    }
    const startT =
      timelineTRef.current >= timeline.activeSegmentCount - 0.001 ? 0 : timelineTRef.current;
    if (startT === 0) {
      timelineTRef.current = 0;
      setUiTimelineT(0);
      lastSpokenKeyRef.current = null;
    }
    unlockAndSpeakForT(startT);
    setIsPlaying(true);
  }, [timeline, isPlaying, unlockAndSpeakForT]);

  const handleReplay = useCallback(() => {
    if (!timeline) return;
    timelineTRef.current = 0;
    setUiTimelineT(0);
    lastSpokenKeyRef.current = null;
    unlockAndSpeakForT(0);
    setIsPlaying(true);
  }, [timeline, unlockAndSpeakForT]);

  const handleSkipToFinish = useCallback(() => {
    if (!timeline) return;
    cancelSpeech();
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

  const toggleRowExpanded = useCallback((userId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }, []);

  const uiFrame = useMemo(() => {
    if (!timeline) {
      return null;
    }
    return sampleRaceTimeline(timeline, uiTimelineT);
  }, [timeline, uiTimelineT]);

  const hasCurrentUser = Boolean(raceData?.standings.some((s) => s.isCurrentUser));
  const isToday = dateMode === 'today' && date === getTodayIsoDate();
  const isCommentaryLoading = commentaryEnabled && Boolean(raceData) && commentaryQuery.isPending;

  const playOverlayMode: 'hidden' | 'play' | 'replay' | 'loading' = useMemo(() => {
    if (!timeline || isPlaying) {
      return 'hidden';
    }
    if (isCommentaryLoading && uiTimelineT <= 0.001) {
      return 'loading';
    }
    if (uiTimelineT >= timeline.activeSegmentCount - 0.001) {
      return 'replay';
    }
    if (uiTimelineT <= 0.001) {
      return 'play';
    }
    return 'hidden';
  }, [timeline, isPlaying, isCommentaryLoading, uiTimelineT]);

  return (
    <div className="page-stack race-page-stack">
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
          {/* Compact Race Controls Strip (single row on desktop, 2 tight rows on mobile so track starts above the fold) */}
          <section className="card race-controls-strip" aria-label="Race filters">
            <div className="race-controls-primary">
              <select
                className="race-group-select"
                aria-label="Racing group"
                value={activeGroupId ?? ''}
                onChange={(e) => handleGroupChange(e.target.value)}
              >
                {groups.map((g) => (
                  <option key={g.groupId} value={g.groupId}>
                    {g.name}
                  </option>
                ))}
              </select>

              <div className="segmented range-segmented" role="group" aria-label="Race time range">
                <button
                  type="button"
                  className={range === 'daily' ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => setRange('daily')}
                >
                  Day
                </button>
                <button
                  type="button"
                  className={range === 'weekly' ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => setRange('weekly')}
                >
                  Week
                </button>
              </div>
            </div>

            <div className="race-controls-secondary">
              <input
                type="date"
                className="race-date-input"
                aria-label="Race date"
                value={date}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val) {
                    setDate(val);
                    setDateMode(val === getTodayIsoDate() ? 'today' : 'custom');
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm race-today-btn"
                disabled={isToday}
                onClick={() => {
                  setDate(getTodayIsoDate());
                  setDateMode('today');
                }}
              >
                Today
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm race-refresh-btn"
                disabled={raceQuery.isFetching}
                onClick={() => void raceQuery.refetch()}
                aria-label="Refresh race standings"
                title={
                  raceData
                    ? `Refresh now · Updated ${formatTime(raceQuery.dataUpdatedAt)} (auto every 30s)`
                    : 'Refresh standings'
                }
              >
                <RefreshIcon size={16} className={raceQuery.isFetching ? 'icon-spin' : undefined} />
                <span className="refresh-btn-text">
                  {raceData ? formatTime(raceQuery.dataUpdatedAt) : 'Sync'}
                </span>
              </button>
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
                    playOverlayMode={playOverlayMode}
                    onPlayOverlayClick={playOverlayMode === 'replay' ? handleReplay : handleTogglePlay}
                    onCameraModeChange={setCameraMode}
                    onToggleLabels={() => setShowLabels((v) => !v)}
                  />
                </Suspense>

                <RaceCommentaryTicker
                  enabled={commentaryEnabled}
                  ttsEnabled={ttsEnabled}
                  ttsVoiceUri={ttsVoiceUri}
                  isPlaying={isPlaying}
                  activeDayDate={uiFrame.activeDay.date}
                  isFinalDay={
                    raceData.range === 'daily' ||
                    uiFrame.activeDayIndex === timeline.days.length - 1
                  }
                  data={commentaryQuery.data}
                  isPending={commentaryQuery.isPending}
                  error={commentaryQuery.error}
                  lastSpokenKeyRef={lastSpokenKeyRef}
                  onToggleEnabled={() => setCommentaryEnabled((v) => !v)}
                  onSetTtsEnabled={setTtsEnabled}
                  onSelectVoiceUri={setTtsVoiceUri}
                />

                <PlaybackControls
                  timeline={timeline}
                  frame={uiFrame}
                  isPlaying={isPlaying}
                  waitingForCommentary={isCommentaryLoading}
                  speed={speed}
                  onTogglePlay={handleTogglePlay}
                  onReplay={handleReplay}
                  onSkipToFinish={handleSkipToFinish}
                  onSpeedChange={setSpeed}
                  onScrub={handleScrub}
                />
              </section>

              <section className="card standings-card">
                <div className="section-head standings-head">
                  <div className="standings-title-group">
                    <h2>Standings</h2>
                    <span className="muted small">
                      {raceData.range === 'weekly'
                        ? `${raceData.startDate} – ${raceData.endDate}`
                        : raceData.date}
                    </span>
                  </div>
                  <div className="standings-meta-right">
                    <span className="muted small standings-hint">Tap a rider for breakdown</span>
                    <code className="code-inline" title="Group invite code">
                      {raceData.group.inviteCode}
                    </code>
                  </div>
                </div>

                <div className="table-wrap">
                  <table className="race-table">
                    <thead>
                      <tr>
                        <th className="col-rank">Rank</th>
                        <th className="col-racer">Racer</th>
                        <th className="col-score">Score</th>
                        <th className="col-steps col-desktop-only">Steps</th>
                        <th className="col-calories col-desktop-only">Active Cal</th>
                        <th className="col-sync col-desktop-only">Sync</th>
                        <th className="col-chevron" aria-label="Details" />
                      </tr>
                    </thead>
                    <tbody>
                      {raceData.standings.map((row) => {
                        const isExpanded = expandedIds.has(row.userId);
                        const rowClasses = [
                          'race-row-clickable',
                          row.isCurrentUser ? 'row-current-user' : '',
                          row.isLeader ? 'row-leader' : '',
                          isExpanded ? 'row-expanded' : '',
                        ]
                          .filter(Boolean)
                          .join(' ');

                        return (
                          <Fragment key={row.userId}>
                            <tr
                              className={rowClasses}
                              onClick={() => toggleRowExpanded(row.userId)}
                              tabIndex={0}
                              role="button"
                              aria-expanded={isExpanded}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  toggleRowExpanded(row.userId);
                                }
                              }}
                            >
                              <td className="col-rank">
                                <div className="rank-cell">
                                  <span className="rank-num">#{row.rank}</span>
                                  {row.isLeader && (
                                    <span className="pill pill-gold pill-leader-badge" title="Current Leader">
                                      <TrophyIcon size={11} />
                                      <span className="leader-word">Leader</span>
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="col-racer">
                                <div className="racer-cell">
                                  <span
                                    className="color-dot"
                                    style={{ backgroundColor: row.bikeColor }}
                                    aria-hidden="true"
                                  />
                                  <div className="racer-identity">
                                    <div className="racer-name">
                                      <strong className="racer-display-name">{row.displayName}</strong>
                                      {row.isCurrentUser && <span className="pill pill-blue">You</span>}
                                    </div>
                                    <span className="muted small racer-slug">@{row.playerSlug}</span>
                                  </div>
                                </div>
                              </td>
                              <td className="col-score">
                                <div className="score-cell">
                                  <strong>{row.weightedScorePct.toFixed(1)}%</strong>
                                  {row.isOverdrive && (
                                    <span className="pill pill-overdrive">OVERDRIVE</span>
                                  )}
                                </div>
                                <div className="mini-bar" aria-hidden="true">
                                  <div
                                    className={`mini-bar-fill${row.isOverdrive ? ' overdrive' : ''}`}
                                    style={{
                                      width: `${Math.min(100, Math.max(0, row.weightedScorePct))}%`,
                                      backgroundColor: row.isOverdrive ? undefined : row.bikeColor,
                                    }}
                                  />
                                </div>
                              </td>
                              <td className="col-steps col-desktop-only">
                                <div>
                                  <strong>{row.steps.toLocaleString()}</strong>{' '}
                                  <span className="muted small">
                                    / {row.stepTarget.toLocaleString()}
                                  </span>
                                </div>
                                <span className="muted small">{row.stepPct.toFixed(1)}%</span>
                              </td>
                              <td className="col-calories col-desktop-only">
                                <div>
                                  <strong>{row.activeCalories.toLocaleString()}</strong>{' '}
                                  <span className="muted small">
                                    / {row.calorieTarget.toLocaleString()} kcal
                                  </span>
                                </div>
                                <span className="muted small">{row.caloriePct.toFixed(1)}%</span>
                              </td>
                              <td className="col-sync col-desktop-only muted small">
                                {formatTime(row.lastUpdatedAt)}
                              </td>
                              <td className="col-chevron">
                                <ChevronDownIcon
                                  size={18}
                                  className={isExpanded ? 'row-chevron open' : 'row-chevron'}
                                />
                              </td>
                            </tr>

                            {isExpanded && (
                              <tr className="breakdown-row">
                                <td colSpan={7}>
                                  <RiderBreakdownPanel
                                    row={row}
                                    range={raceData.range}
                                    timeline={timeline}
                                    activeDayIndex={uiFrame.activeDayIndex}
                                    onJumpToDay={(dayIndex) => handleScrub(dayIndex)}
                                  />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
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
