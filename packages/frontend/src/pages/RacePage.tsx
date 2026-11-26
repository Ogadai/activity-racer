import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  getTodayIsoDate,
  isValidIsoDate,
  type RaceRange,
  type RaceResponse,
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
  computeRaceOutcomeSignature,
  formatDayLabels,
  sampleRaceTimeline,
  type RaceTimeline,
} from '../race/trackMath';
import { cancelSpeech, speakText } from '../race/tts';
import styles from './RacePage.module.css';

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

interface SyncedCommentarySignature {
  outcomeSig: string;
  dataSig: string;
  dataUpdatedAt: number;
}

// Persists across route navigation so returning to /race detects stale React Query commentary
const syncedCommentaryByRace = new Map<string, SyncedCommentarySignature>();

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
  range: 'weekly',
  dateMode: 'today',
  customDate: null,
  cameraMode: 'me',
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
    <div className={styles.breakdownPanel}>
      {/* Personal formula & metadata */}
      <div className={styles.breakdownFormulaRow}>
        <span className={styles.breakdownFormulaText}>
          <strong>Target formula:</strong>{' '}
          {stepWeightPct}% × Steps / {dailyStepTarget.toLocaleString()}
          {' + '}
          {calWeightPct}% × Cal / {dailyCalTarget.toLocaleString()} kcal
          {range === 'weekly' && ' (÷ 7 days)'}
        </span>
        <span className="muted small">
          {range === 'weekly' && `${row.daysLogged}/7 days logged · `}
          Sync: {formatTime(row.lastUpdatedAt)}
        </span>
      </div>

      {/* Raw vs. normalized progress metrics */}
      <div className={styles.breakdownMetricsGrid}>
        <div className={styles.breakdownMetricCard}>
          <div className={styles.breakdownMetricHead}>
            <span className={styles.breakdownMetricTitle}>
              <StepsIcon size={15} />
              <span>Steps</span>
            </span>
            <span className={styles.breakdownMetricPct}>
              <strong>{row.stepPct.toFixed(1)}%</strong>
              <span className="muted small"> (+{stepWeightedContrib.toFixed(1)} wt)</span>
            </span>
          </div>
          <div className={styles.breakdownMetricRaw}>
            <strong>{row.steps.toLocaleString()}</strong>
            <span className="muted small"> / {row.stepTarget.toLocaleString()}</span>
          </div>
          <div className={styles.breakdownBarTrack} aria-hidden="true">
            <div
              className={`${styles.breakdownBarFill}${row.stepPct > 100 ? ` ${styles.overdrive}` : ''}`}
              style={{
                width: `${Math.min(100, Math.max(0, row.stepPct))}%`,
                backgroundColor: row.stepPct > 100 ? undefined : row.bikeColor,
              }}
            />
          </div>
        </div>

        <div className={styles.breakdownMetricCard}>
          <div className={styles.breakdownMetricHead}>
            <span className={styles.breakdownMetricTitle}>
              <FlameIcon size={15} />
              <span>Active Calories</span>
            </span>
            <span className={styles.breakdownMetricPct}>
              <strong>{row.caloriePct.toFixed(1)}%</strong>
              <span className="muted small"> (+{calWeightedContrib.toFixed(1)} wt)</span>
            </span>
          </div>
          <div className={styles.breakdownMetricRaw}>
            <strong>{row.activeCalories.toLocaleString()}</strong>
            <span className="muted small"> / {row.calorieTarget.toLocaleString()} kcal</span>
          </div>
          <div className={styles.breakdownBarTrack} aria-hidden="true">
            <div
              className={`${styles.breakdownBarFill}${row.caloriePct > 100 ? ` ${styles.overdrive}` : ''}`}
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
        <div className={styles.weeklyBarsSection}>
          <div className={styles.weeklyBarsHeader}>
            <span className="small">
              <strong>Mon–Sun Daily Pace</strong>
            </span>
            <span className="muted small">Tap a day to jump replay · Dashed line = 100%</span>
          </div>

          <div className={styles.weeklyBarsGrid}>
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
                  className={`${styles.weeklyBarCol}${isActive ? ` ${styles.active}` : ''}${
                    isUpcoming ? ` ${styles.upcoming}` : ''
                  }${day.isOverdrive ? ` ${styles.overdrive}` : ''}`}
                  title={`${shortLabel} (${day.date}): ${day.weightedScorePct.toFixed(1)}% · ${day.steps.toLocaleString()} steps · ${day.activeCalories.toLocaleString()} kcal`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isUpcoming) {
                      onJumpToDay(idx);
                    }
                  }}
                >
                  <span className={styles.weeklyBarPct}>
                    {isUpcoming ? '—' : `${Math.round(day.weightedScorePct)}%`}
                  </span>
                  <div className={styles.weeklyBarWell} aria-hidden="true">
                    <span className={styles.weeklyBarTargetLine} />
                    <div
                      className={`${styles.weeklyBarStick}${day.isOverdrive ? ` ${styles.overdrive}` : ''}`}
                      style={{
                        height: `${heightPct}%`,
                        backgroundColor: day.isOverdrive ? undefined : row.bikeColor,
                      }}
                    />
                  </div>
                  <span className={styles.weeklyBarDay}>{shortLabel}</span>
                  <span className={styles.weeklyBarRaw}>
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
  const [pendingPlayStartT, setPendingPlayStartT] = useState<number | null>(null);
  const [syncedCommentaryVersion, setSyncedCommentaryVersion] = useState<number>(0);
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
  const inFlightCommentaryRef = useRef<{
    identity: string;
    outcomeSig: string;
    dataSig: string;
  } | null>(null);

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
  const raceOutcomeSignature = raceData ? computeRaceOutcomeSignature(raceData) : null;

  // Track which race outcome/data signature the cached commentary corresponds to
  useEffect(() => {
    if (!raceIdentity || !raceOutcomeSignature || !raceSignature) {
      return;
    }

    if (commentaryQuery.isFetching) {
      if (
        !inFlightCommentaryRef.current ||
        inFlightCommentaryRef.current.identity !== raceIdentity
      ) {
        inFlightCommentaryRef.current = {
          identity: raceIdentity,
          outcomeSig: raceOutcomeSignature,
          dataSig: raceSignature,
        };
      }
      return;
    }

    if (commentaryQuery.isSuccess && commentaryQuery.dataUpdatedAt > 0) {
      const existing = syncedCommentaryByRace.get(raceIdentity);
      if (!existing || existing.dataUpdatedAt !== commentaryQuery.dataUpdatedAt) {
        const captured =
          inFlightCommentaryRef.current?.identity === raceIdentity
            ? inFlightCommentaryRef.current
            : {
                identity: raceIdentity,
                outcomeSig: raceOutcomeSignature,
                dataSig: raceSignature,
              };
        syncedCommentaryByRace.set(raceIdentity, {
          outcomeSig: captured.outcomeSig,
          dataSig: captured.dataSig,
          dataUpdatedAt: commentaryQuery.dataUpdatedAt,
        });
        setSyncedCommentaryVersion((v) => v + 1);
      }
      inFlightCommentaryRef.current = null;
      return;
    }

    if (commentaryQuery.isError) {
      inFlightCommentaryRef.current = null;
    }
  }, [
    raceIdentity,
    raceOutcomeSignature,
    raceSignature,
    commentaryQuery.isFetching,
    commentaryQuery.isSuccess,
    commentaryQuery.isError,
    commentaryQuery.dataUpdatedAt,
  ]);

  // Reading syncedCommentaryVersion ensures re-evaluation when module-level map updates
  const syncedCommentaryEntry = useMemo(() => {
    void syncedCommentaryVersion;
    return raceIdentity ? syncedCommentaryByRace.get(raceIdentity) : undefined;
  }, [raceIdentity, syncedCommentaryVersion]);

  const isCommentaryStale = Boolean(
    commentaryEnabled &&
      raceData &&
      raceOutcomeSignature &&
      commentaryQuery.data &&
      syncedCommentaryEntry &&
      syncedCommentaryEntry.outcomeSig !== raceOutcomeSignature,
  );

  const triggerCommentaryRefresh = useCallback(
    (targetRace?: RaceResponse) => {
      const source = targetRace ?? raceData;
      if (!commentaryEnabled || !source) {
        return;
      }
      inFlightCommentaryRef.current = {
        identity: computeRaceIdentity(source),
        outcomeSig: computeRaceOutcomeSignature(source),
        dataSig: computeRaceDataSignature(source),
      };
      void commentaryQuery.refetch();
    },
    [commentaryEnabled, raceData, commentaryQuery],
  );

  const handleRefresh = useCallback(async () => {
    const result = await raceQuery.refetch();
    const nextRace = result.data;
    if (!commentaryEnabled || !nextRace) {
      return;
    }
    const nextIdentity = computeRaceIdentity(nextRace);
    const nextDataSig = computeRaceDataSignature(nextRace);
    const nextOutcomeSig = computeRaceOutcomeSignature(nextRace);
    const synced = syncedCommentaryByRace.get(nextIdentity);
    const needsCommentaryRefresh =
      !synced || synced.outcomeSig !== nextOutcomeSig || synced.dataSig !== nextDataSig;
    if (needsCommentaryRefresh) {
      triggerCommentaryRefresh(nextRace);
    }
  }, [raceQuery, commentaryEnabled, triggerCommentaryRefresh]);

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
      setPendingPlayStartT(null);
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
    if (pendingPlayStartT !== null) {
      return;
    }
    const startT =
      timelineTRef.current >= timeline.activeSegmentCount - 0.001 ? 0 : timelineTRef.current;
    if (startT === 0) {
      timelineTRef.current = 0;
      setUiTimelineT(0);
      lastSpokenKeyRef.current = null;
    }
    const needsCommentaryWait =
      commentaryEnabled &&
      (isCommentaryStale || commentaryQuery.isPending || commentaryQuery.isFetching);
    if (needsCommentaryWait) {
      // Unlock browser speechSynthesis synchronously inside the user's click gesture
      if (ttsEnabled) {
        speakText(' ', ttsVoiceUri);
      }
      setPendingPlayStartT(startT);
      if (isCommentaryStale && !commentaryQuery.isFetching) {
        triggerCommentaryRefresh();
      }
      return;
    }
    unlockAndSpeakForT(startT);
    setIsPlaying(true);
  }, [
    timeline,
    isPlaying,
    pendingPlayStartT,
    commentaryEnabled,
    isCommentaryStale,
    commentaryQuery.isPending,
    commentaryQuery.isFetching,
    ttsEnabled,
    ttsVoiceUri,
    triggerCommentaryRefresh,
    unlockAndSpeakForT,
  ]);

  const handleReplay = useCallback(() => {
    if (!timeline) return;
    cancelSpeech();
    timelineTRef.current = 0;
    setUiTimelineT(0);
    lastSpokenKeyRef.current = null;
    const needsCommentaryWait =
      commentaryEnabled &&
      (isCommentaryStale || commentaryQuery.isPending || commentaryQuery.isFetching);
    if (needsCommentaryWait) {
      if (ttsEnabled) {
        speakText(' ', ttsVoiceUri);
      }
      setIsPlaying(false);
      setPendingPlayStartT(0);
      if (isCommentaryStale && !commentaryQuery.isFetching) {
        triggerCommentaryRefresh();
      }
      return;
    }
    unlockAndSpeakForT(0);
    setIsPlaying(true);
  }, [
    timeline,
    commentaryEnabled,
    isCommentaryStale,
    commentaryQuery.isPending,
    commentaryQuery.isFetching,
    ttsEnabled,
    ttsVoiceUri,
    triggerCommentaryRefresh,
    unlockAndSpeakForT,
  ]);

  // Start deferred playback automatically as soon as updated commentary finishes loading
  useEffect(() => {
    if (pendingPlayStartT === null || !timeline) {
      return;
    }
    if (!commentaryEnabled) {
      const targetT = Math.min(timeline.activeSegmentCount, pendingPlayStartT);
      timelineTRef.current = targetT;
      setUiTimelineT(targetT);
      setPendingPlayStartT(null);
      setIsPlaying(true);
      return;
    }
    if (
      commentaryQuery.isPending ||
      commentaryQuery.isFetching ||
      (isCommentaryStale && !commentaryQuery.isError)
    ) {
      return;
    }
    const targetT = Math.min(timeline.activeSegmentCount, pendingPlayStartT);
    timelineTRef.current = targetT;
    setUiTimelineT(targetT);
    lastSpokenKeyRef.current = null;
    setPendingPlayStartT(null);
    setIsPlaying(true);
  }, [
    pendingPlayStartT,
    timeline,
    commentaryEnabled,
    isCommentaryStale,
    commentaryQuery.isPending,
    commentaryQuery.isFetching,
    commentaryQuery.isError,
  ]);

  const handleSkipToFinish = useCallback(() => {
    if (!timeline) return;
    cancelSpeech();
    setPendingPlayStartT(null);
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
  const isCommentaryLoading =
    commentaryEnabled &&
    Boolean(raceData) &&
    (commentaryQuery.isPending ||
      pendingPlayStartT !== null ||
      (commentaryQuery.isFetching && isCommentaryStale));

  const playOverlayMode: 'hidden' | 'play' | 'replay' | 'loading' = useMemo(() => {
    if (!timeline || isPlaying) {
      return 'hidden';
    }
    if (pendingPlayStartT !== null) {
      return 'loading';
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
  }, [timeline, isPlaying, pendingPlayStartT, isCommentaryLoading, uiTimelineT]);

  return (
    <div className={`page-stack ${styles.racePageStack}`}>
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
          <section className={`card ${styles.controlsStrip}`} aria-label="Race filters">
            <div className={styles.controlsPrimary}>
              <select
                className={styles.groupSelect}
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

              <div className={`segmented ${styles.rangeSegmented}`} role="group" aria-label="Race time range">
                <button
                  type="button"
                  className={
                    range === 'daily'
                      ? `seg-btn ${styles.rangeSegBtn} active`
                      : `seg-btn ${styles.rangeSegBtn}`
                  }
                  onClick={() => setRange('daily')}
                >
                  Day
                </button>
                <button
                  type="button"
                  className={
                    range === 'weekly'
                      ? `seg-btn ${styles.rangeSegBtn} active`
                      : `seg-btn ${styles.rangeSegBtn}`
                  }
                  onClick={() => setRange('weekly')}
                >
                  Week
                </button>
              </div>
            </div>

            <div className={styles.controlsSecondary}>
              <input
                type="date"
                className={styles.dateInput}
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
                className={`btn btn-secondary btn-sm ${styles.todayBtn}`}
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
                className={`btn btn-secondary btn-sm ${styles.refreshBtn}`}
                disabled={raceQuery.isFetching}
                onClick={() => void handleRefresh()}
                aria-label="Refresh race standings"
                title={
                  raceData
                    ? `Refresh now · Updated ${formatTime(raceQuery.dataUpdatedAt)} (auto every 30s)`
                    : 'Refresh standings'
                }
              >
                <RefreshIcon size={16} className={raceQuery.isFetching ? styles.iconSpin : undefined} />
                <span className={styles.refreshBtnText}>
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
              <section className={`card ${styles.velodromeCard}`}>
                <Suspense
                  fallback={
                    <div className={styles.velodromeLoading}>
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
                  isFetching={commentaryQuery.isFetching}
                  isStale={isCommentaryStale}
                  error={commentaryQuery.error}
                  lastSpokenKeyRef={lastSpokenKeyRef}
                  onToggleEnabled={() => setCommentaryEnabled((v) => !v)}
                  onRefreshCommentary={() => triggerCommentaryRefresh()}
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

              <section className={`card ${styles.standingsCard}`}>
                <div className={`section-head ${styles.standingsHead}`}>
                  <div className={styles.standingsTitleGroup}>
                    <h2>Standings</h2>
                    <span className="muted small">
                      {raceData.range === 'weekly'
                        ? `${raceData.startDate} – ${raceData.endDate}`
                        : raceData.date}
                    </span>
                  </div>
                  <div className={styles.standingsMetaRight}>
                    <span className={`muted small ${styles.standingsHint}`}>
                      Tap a rider for breakdown
                    </span>
                    <code className="code-inline" title="Group invite code">
                      {raceData.group.inviteCode}
                    </code>
                  </div>
                </div>

                <div className={styles.tableWrap}>
                  <table className={styles.raceTable}>
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Racer</th>
                        <th>Score</th>
                        <th className={styles.colDesktopOnly}>Steps</th>
                        <th className={styles.colDesktopOnly}>Active Cal</th>
                        <th className={styles.colDesktopOnly}>Sync</th>
                        <th className={styles.colChevron} aria-label="Details" />
                      </tr>
                    </thead>
                    <tbody>
                      {raceData.standings.map((row) => {
                        const isExpanded = expandedIds.has(row.userId);
                        const rowClasses = [
                          styles.raceRowClickable,
                          row.isCurrentUser ? styles.rowCurrentUser : '',
                          row.isLeader ? styles.rowLeader : '',
                          isExpanded ? styles.rowExpanded : '',
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
                              <td>
                                <div className={styles.rankCell}>
                                  <span className={styles.rankNum}>#{row.rank}</span>
                                  {row.isLeader && (
                                    <span
                                      className={`pill pill-gold ${styles.pillLeaderBadge}`}
                                      title="Current Leader"
                                    >
                                      <TrophyIcon size={11} />
                                      <span className={styles.leaderWord}>Leader</span>
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td>
                                <div className={styles.racerCell}>
                                  <span
                                    className="color-dot"
                                    style={{ backgroundColor: row.bikeColor }}
                                    aria-hidden="true"
                                  />
                                  <div className={styles.racerIdentity}>
                                    <div className={styles.racerName}>
                                      <strong className={styles.racerDisplayName}>
                                        {row.displayName}
                                      </strong>
                                      {row.isCurrentUser && <span className="pill pill-blue">You</span>}
                                    </div>
                                    <span className={`muted small ${styles.racerSlug}`}>
                                      @{row.playerSlug}
                                    </span>
                                  </div>
                                </div>
                              </td>
                              <td>
                                <div className={styles.scoreCell}>
                                  <strong>{row.weightedScorePct.toFixed(1)}%</strong>
                                  {row.isOverdrive && (
                                    <span className="pill pill-overdrive">OVERDRIVE</span>
                                  )}
                                </div>
                                <div className={styles.miniBar} aria-hidden="true">
                                  <div
                                    className={`${styles.miniBarFill}${row.isOverdrive ? ` ${styles.overdrive}` : ''}`}
                                    style={{
                                      width: `${Math.min(100, Math.max(0, row.weightedScorePct))}%`,
                                      backgroundColor: row.isOverdrive ? undefined : row.bikeColor,
                                    }}
                                  />
                                </div>
                              </td>
                              <td className={styles.colDesktopOnly}>
                                <div>
                                  <strong>{row.steps.toLocaleString()}</strong>{' '}
                                  <span className="muted small">
                                    / {row.stepTarget.toLocaleString()}
                                  </span>
                                </div>
                                <span className="muted small">{row.stepPct.toFixed(1)}%</span>
                              </td>
                              <td className={styles.colDesktopOnly}>
                                <div>
                                  <strong>{row.activeCalories.toLocaleString()}</strong>{' '}
                                  <span className="muted small">
                                    / {row.calorieTarget.toLocaleString()} kcal
                                  </span>
                                </div>
                                <span className="muted small">{row.caloriePct.toFixed(1)}%</span>
                              </td>
                              <td className={`${styles.colDesktopOnly} muted small`}>
                                {formatTime(row.lastUpdatedAt)}
                              </td>
                              <td className={styles.colChevron}>
                                <ChevronDownIcon
                                  size={18}
                                  className={
                                    isExpanded
                                      ? `${styles.rowChevron} ${styles.open}`
                                      : styles.rowChevron
                                  }
                                />
                              </td>
                            </tr>

                            {isExpanded && (
                              <tr className={styles.breakdownRow}>
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
