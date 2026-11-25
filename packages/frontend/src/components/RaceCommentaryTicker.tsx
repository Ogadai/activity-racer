import { useEffect, useRef } from 'react';
import type { RaceCommentaryResponse } from '@activity-racer/shared';
import { ApiError } from '../api/client';
import { CloseIcon, MicIcon, VolumeOffIcon, VolumeOnIcon } from './Icons';

interface RaceCommentaryTickerProps {
  enabled: boolean;
  ttsEnabled: boolean;
  isPlaying: boolean;
  activeDayDate: string;
  isFinalDay: boolean;
  data: RaceCommentaryResponse | undefined;
  isPending: boolean;
  error: unknown;
  onToggleEnabled: () => void;
  onToggleTts: () => void;
}

function hasSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function RaceCommentaryTicker({
  enabled,
  ttsEnabled,
  isPlaying,
  activeDayDate,
  isFinalDay,
  data,
  isPending,
  error,
  onToggleEnabled,
  onToggleTts,
}: RaceCommentaryTickerProps) {
  const lastSpokenKeyRef = useRef<string | null>(null);

  const activeEntry =
    data?.days.find((d) => d.date === activeDayDate) ??
    data?.days[data.days.length - 1] ??
    null;

  // Optional zero-cost browser Web Speech API read-aloud synced to each animating day
  useEffect(() => {
    if (!hasSpeechSynthesis()) {
      return;
    }

    if (!enabled || !ttsEnabled || !activeEntry?.commentary) {
      window.speechSynthesis.cancel();
      lastSpokenKeyRef.current = null;
      return;
    }

    if (!isPlaying) {
      window.speechSynthesis.cancel();
      return;
    }

    const speakKey = `${data?.generatedAt ?? ''}|${activeEntry.date}|${activeEntry.commentary}`;
    if (lastSpokenKeyRef.current === speakKey) {
      return;
    }
    lastSpokenKeyRef.current = speakKey;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(activeEntry.commentary);
    utterance.voice = window.speechSynthesis.getVoices().find((v) =>
      v.lang.startsWith('en-GB') && v.name === 'Google UK English Male'
    ) ?? null;
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  }, [enabled, ttsEnabled, isPlaying, activeEntry, data?.generatedAt]);

  useEffect(() => {
    return () => {
      if (hasSpeechSynthesis()) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  if (!enabled) {
    return (
      <div className="commentary-ticker commentary-collapsed">
        <button
          type="button"
          className="commentary-enable-btn"
          onClick={onToggleEnabled}
        >
          <MicIcon size={15} />
          <span>Enable AI Race Announcer</span>
        </button>
      </div>
    );
  }

  const isNotConfigured = error instanceof ApiError && error.status === 503;

  return (
    <div
      className={`commentary-ticker${isFinalDay && activeEntry ? ' final-day' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="commentary-body">
        {isPending && !data && (
          <p className="commentary-text muted">Tuning into the velodrome booth...</p>
        )}

        {!isPending && isNotConfigured && (
          <p className="commentary-text muted">
            AI Announcer ready once your Gemini key is saved in SSM (
            <code className="code-inline">/activity-racer/gemini-api-key</code>).
          </p>
        )}

        {!isPending && Boolean(error) && !isNotConfigured && (
          <p className="commentary-text muted">
            {error instanceof Error ? error.message : 'Race commentary temporarily unavailable.'}
          </p>
        )}

        {activeEntry && (
          <p key={activeEntry.date} className="commentary-text commentary-fade-in">
            {activeEntry.commentary}
          </p>
        )}
      </div>

      <div className="commentary-actions">
        <button
          type="button"
          className="btn btn-secondary btn-xs commentary-icon-btn"
          onClick={onToggleEnabled}
          aria-label="Hide AI Race Announcer"
          title="Hide commentary"
        >
          <CloseIcon size={14} />
        </button>
        {hasSpeechSynthesis() && activeEntry && (
          <button
            type="button"
            className={`btn btn-secondary btn-xs commentary-icon-btn${ttsEnabled ? ' active' : ''}`}
            onClick={onToggleTts}
            aria-pressed={ttsEnabled}
            aria-label={ttsEnabled ? 'Mute read aloud' : 'Read commentary aloud'}
            title={ttsEnabled ? 'Mute read aloud' : 'Read aloud (browser voice)'}
          >
            {ttsEnabled ? <VolumeOnIcon size={14} /> : <VolumeOffIcon size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}
