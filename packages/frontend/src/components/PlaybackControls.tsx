import type { RaceTimeline, RaceTimelineFrame } from '../race/trackMath';
import { PauseIcon, PlayIcon, ReplayIcon, SkipEndIcon } from './Icons';
import styles from './PlaybackControls.module.css';

export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

interface PlaybackControlsProps {
  timeline: RaceTimeline;
  frame: RaceTimelineFrame;
  isPlaying: boolean;
  waitingForCommentary?: boolean;
  speed: PlaybackSpeed;
  onTogglePlay: () => void;
  onReplay: () => void;
  onSkipToFinish: () => void;
  onSpeedChange: (speed: PlaybackSpeed) => void;
  onScrub: (nextT: number) => void;
}

export function PlaybackControls({
  timeline,
  frame,
  isPlaying,
  waitingForCommentary = false,
  speed,
  onTogglePlay,
  onReplay,
  onSkipToFinish,
  onSpeedChange,
  onScrub,
}: PlaybackControlsProps) {
  const maxT = timeline.activeSegmentCount;
  const isAtFinish = frame.t >= maxT - 0.001;
  const fillPct = maxT > 0 ? Math.min(100, Math.max(0, (frame.t / maxT) * 100)) : 100;

  return (
    <div className={styles.panel}>
      {/* Compact Broadcast HUD: Active Day + Live Dynamic Rank Order */}
      <div className={styles.broadcastHud}>
        <div className={styles.broadcastHudDay}>
          <span
            className={isPlaying ? `${styles.hudStatusDot} ${styles.live}` : styles.hudStatusDot}
            aria-hidden="true"
          />
          <span className={styles.hudDayLabel}>
            {frame.activeDay?.fullLabel ?? (timeline.range === 'weekly' ? 'Weekly' : 'Daily')}
          </span>
          <span className={styles.hudStateTag}>
            {isPlaying
              ? 'Live'
              : waitingForCommentary
                ? 'Loading'
                : isAtFinish
                  ? 'Finish'
                  : frame.t <= 0.001
                    ? 'Ready'
                    : 'Paused'}
          </span>
        </div>

        <div className={styles.broadcastHudRanks} aria-label="Live race rank order">
          {frame.liveStandings.slice(0, 5).map((rider) => (
            <div
              key={rider.userId}
              className={`${styles.hudRankChip}${rider.isLiveLeader ? ` ${styles.leader}` : ''}${
                rider.standing.isCurrentUser ? ` ${styles.self}` : ''
              }`}
            >
              <span className={styles.hudRankPos}>#{rider.liveRank}</span>
              <span
                className="color-dot"
                style={{ backgroundColor: rider.standing.bikeColor }}
                aria-hidden="true"
              />
              <span className={styles.hudRankName}>{rider.standing.displayName}</span>
              <span className={styles.hudRankVal}>
                {timeline.range === 'weekly'
                  ? `${rider.laps.toFixed(2)}L`
                  : `${rider.livePct.toFixed(0)}%`}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Interactive Timeline Scrubber + Day Markers */}
      <div className={styles.scrubberBlock}>
        <div className={styles.scrubberTrackWrap}>
          <input
            type="range"
            className={styles.scrubberInput}
            aria-label="Race timeline scrubber"
            min={0}
            max={maxT}
            step={0.005}
            value={frame.t}
            style={{ '--scrubber-fill': `${fillPct}%` } as React.CSSProperties}
            onChange={(e) => onScrub(Number(e.target.value))}
          />
        </div>

        {timeline.range === 'weekly' ? (
          <div className={styles.dayMarkers} role="group" aria-label="Jump to race day">
            {timeline.days.map((day) => {
              const isCurrent = !day.isUpcoming && frame.activeDayIndex === day.index;
              const isCompleted = !day.isUpcoming && frame.t >= day.index + 0.999;
              return (
                <button
                  key={day.date}
                  type="button"
                  disabled={day.isUpcoming}
                  title={day.isUpcoming ? `${day.fullLabel} (Upcoming)` : `Jump to ${day.fullLabel}`}
                  className={`${styles.dayMarkerBtn}${isCurrent ? ` ${styles.active}` : ''}${
                    isCompleted ? ` ${styles.completed}` : ''
                  }${day.isUpcoming ? ` ${styles.upcoming}` : ''}`}
                  onClick={() => onScrub(day.index)}
                >
                  <span>{day.shortLabel}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className={styles.dailyMarkers}>
            <button type="button" className={styles.dayMarkerLink} onClick={() => onScrub(0)}>
              Start
            </button>
            <span className="muted small">{Math.round(frame.progress * 100)}%</span>
            <button type="button" className={styles.dayMarkerLink} onClick={() => onScrub(maxT)}>
              Finish
            </button>
          </div>
        )}
      </div>

      {/* Single-line Transport & Speed Controls */}
      <div className={styles.transportBar}>
        <div className={styles.transportButtons}>
          <button
            type="button"
            className={`btn btn-primary btn-sm ${styles.transportBtn}`}
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause race animation' : isAtFinish ? 'Play again' : 'Play race animation'}
            title={isPlaying ? 'Pause' : isAtFinish ? 'Play Again' : 'Play'}
          >
            {isPlaying ? <PauseIcon size={17} /> : <PlayIcon size={17} />}
            <span className={styles.transportBtnLabel}>
              {isPlaying ? 'Pause' : isAtFinish ? 'Play Again' : 'Play'}
            </span>
          </button>
          <button
            type="button"
            className={`btn btn-secondary btn-sm ${styles.transportBtn}`}
            onClick={onReplay}
            aria-label="Replay race from start"
            title="Replay"
          >
            <ReplayIcon size={17} />
            <span className={styles.transportBtnLabel}>Replay</span>
          </button>
          <button
            type="button"
            className={`btn btn-secondary btn-sm ${styles.transportBtn}`}
            onClick={onSkipToFinish}
            disabled={isAtFinish && !isPlaying}
            aria-label="Skip to final standings"
            title="Skip to Finish"
          >
            <SkipEndIcon size={17} />
            <span className={styles.transportBtnLabel}>Finish</span>
          </button>
        </div>

        <div className={styles.speedControl}>
          <span className={`muted small ${styles.speedLabel}`}>Speed</span>
          <div className="segmented" role="group" aria-label="Playback speed">
            {PLAYBACK_SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className={
                  speed === s
                    ? `seg-btn ${styles.speedBtn} active`
                    : `seg-btn ${styles.speedBtn}`
                }
                onClick={() => onSpeedChange(s)}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
