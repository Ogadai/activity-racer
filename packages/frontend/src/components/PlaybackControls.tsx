import type { RaceTimeline, RaceTimelineFrame } from '../race/trackMath';
import { PauseIcon, PlayIcon, ReplayIcon, SkipEndIcon } from './Icons';

export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

interface PlaybackControlsProps {
  timeline: RaceTimeline;
  frame: RaceTimelineFrame;
  isPlaying: boolean;
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
    <div className="playback-panel">
      {/* Compact Broadcast HUD: Active Day + Live Dynamic Rank Order */}
      <div className="broadcast-hud">
        <div className="broadcast-hud-day">
          <span className={isPlaying ? 'hud-status-dot live' : 'hud-status-dot'} aria-hidden="true" />
          <span className="hud-day-label">
            {frame.activeDay?.fullLabel ?? (timeline.range === 'weekly' ? 'Weekly' : 'Daily')}
          </span>
          <span className="hud-state-tag">
            {isPlaying ? 'Live' : isAtFinish ? 'Finish' : 'Paused'}
          </span>
        </div>

        <div className="broadcast-hud-ranks" aria-label="Live race rank order">
          {frame.liveStandings.slice(0, 5).map((rider) => (
            <div
              key={rider.userId}
              className={`hud-rank-chip${rider.isLiveLeader ? ' leader' : ''}${
                rider.standing.isCurrentUser ? ' self' : ''
              }`}
            >
              <span className="hud-rank-pos">#{rider.liveRank}</span>
              <span
                className="color-dot"
                style={{ backgroundColor: rider.standing.bikeColor }}
                aria-hidden="true"
              />
              <span className="hud-rank-name">{rider.standing.displayName}</span>
              <span className="hud-rank-val">
                {timeline.range === 'weekly'
                  ? `${rider.laps.toFixed(2)}L`
                  : `${rider.livePct.toFixed(0)}%`}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Interactive Timeline Scrubber + Day Markers */}
      <div className="scrubber-block">
        <div className="scrubber-track-wrap">
          <input
            type="range"
            className="scrubber-input"
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
          <div className="day-markers" role="group" aria-label="Jump to race day">
            {timeline.days.map((day) => {
              const isCurrent = !day.isUpcoming && frame.activeDayIndex === day.index;
              const isCompleted = !day.isUpcoming && frame.t >= day.index + 0.999;
              return (
                <button
                  key={day.date}
                  type="button"
                  disabled={day.isUpcoming}
                  title={day.isUpcoming ? `${day.fullLabel} (Upcoming)` : `Jump to ${day.fullLabel}`}
                  className={`day-marker-btn${isCurrent ? ' active' : ''}${
                    isCompleted ? ' completed' : ''
                  }${day.isUpcoming ? ' upcoming' : ''}`}
                  onClick={() => onScrub(day.index)}
                >
                  <span>{day.shortLabel}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="daily-markers">
            <button type="button" className="day-marker-link" onClick={() => onScrub(0)}>
              Start
            </button>
            <span className="muted small">{Math.round(frame.progress * 100)}%</span>
            <button type="button" className="day-marker-link" onClick={() => onScrub(maxT)}>
              Finish
            </button>
          </div>
        )}
      </div>

      {/* Single-line Transport & Speed Controls */}
      <div className="transport-bar">
        <div className="transport-buttons">
          <button
            type="button"
            className="btn btn-primary btn-sm transport-btn"
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause race animation' : isAtFinish ? 'Play again' : 'Play race animation'}
            title={isPlaying ? 'Pause' : isAtFinish ? 'Play Again' : 'Play'}
          >
            {isPlaying ? <PauseIcon size={17} /> : <PlayIcon size={17} />}
            <span className="transport-btn-label">
              {isPlaying ? 'Pause' : isAtFinish ? 'Play Again' : 'Play'}
            </span>
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm transport-btn"
            onClick={onReplay}
            aria-label="Replay race from start"
            title="Replay"
          >
            <ReplayIcon size={17} />
            <span className="transport-btn-label">Replay</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm transport-btn"
            onClick={onSkipToFinish}
            disabled={isAtFinish && !isPlaying}
            aria-label="Skip to final standings"
            title="Skip to Finish"
          >
            <SkipEndIcon size={17} />
            <span className="transport-btn-label">Finish</span>
          </button>
        </div>

        <div className="speed-control">
          <span className="muted small speed-label">Speed</span>
          <div className="segmented" role="group" aria-label="Playback speed">
            {PLAYBACK_SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className={speed === s ? 'seg-btn speed-btn active' : 'seg-btn speed-btn'}
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
