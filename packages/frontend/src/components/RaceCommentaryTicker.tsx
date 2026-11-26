import { useEffect, useRef, useState } from 'react';
import type { RaceCommentaryResponse } from '@activity-racer/shared';
import { ApiError } from '../api/client';
import {
  cancelSpeech,
  getLocaleVoices,
  hasSpeechSynthesis,
  speakText,
  subscribeVoicesChanged,
} from '../race/tts';
import { CloseIcon, MicIcon, VolumeOffIcon, VolumeOnIcon } from './Icons';
import styles from './RaceCommentaryTicker.module.css';

interface RaceCommentaryTickerProps {
  enabled: boolean;
  ttsEnabled: boolean;
  ttsVoiceUri: string | null;
  isPlaying: boolean;
  activeDayDate: string;
  isFinalDay: boolean;
  data: RaceCommentaryResponse | undefined;
  isPending: boolean;
  isFetching: boolean;
  isStale: boolean;
  error: unknown;
  lastSpokenKeyRef: React.MutableRefObject<string | null>;
  onToggleEnabled: () => void;
  onRefreshCommentary: () => void;
  onSetTtsEnabled: (enabled: boolean) => void;
  onSelectVoiceUri: (voiceUri: string | null) => void;
}

export function buildCommentarySpeakKey(
  generatedAt: string | undefined,
  date: string,
  commentary: string,
): string {
  return `${generatedAt ?? ''}|${date}|${commentary}`;
}

export function RaceCommentaryTicker({
  enabled,
  ttsEnabled,
  ttsVoiceUri,
  isPlaying,
  activeDayDate,
  isFinalDay,
  data,
  isPending,
  isFetching,
  isStale,
  error,
  lastSpokenKeyRef,
  onToggleEnabled,
  onRefreshCommentary,
  onSetTtsEnabled,
  onSelectVoiceUri,
}: RaceCommentaryTickerProps) {
  const [voiceMenuOpen, setVoiceMenuOpen] = useState(false);
  const [voiceList, setVoiceList] = useState(() => getLocaleVoices());
  const actionsWrapRef = useRef<HTMLDivElement | null>(null);

  const activeEntry =
    data?.days.find((d) => d.date === activeDayDate) ??
    data?.days[data.days.length - 1] ??
    null;

  // Keep locale voice list updated when browser loads voices asynchronously
  useEffect(() => {
    const refresh = () => setVoiceList(getLocaleVoices());
    refresh();
    return subscribeVoicesChanged(refresh);
  }, []);

  // Dismiss voice picker popup on outside click or Escape key
  useEffect(() => {
    if (!voiceMenuOpen) {
      return;
    }
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      if (actionsWrapRef.current && !actionsWrapRef.current.contains(e.target as Node)) {
        setVoiceMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setVoiceMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [voiceMenuOpen]);

  // Speak each newly entered day while playing (skips Day 1 if Play click already spoke it)
  useEffect(() => {
    if (!hasSpeechSynthesis()) {
      return;
    }

    if (!enabled || !ttsEnabled || isStale || isFetching || !activeEntry?.commentary) {
      cancelSpeech();
      lastSpokenKeyRef.current = null;
      return;
    }

    if (!isPlaying) {
      return;
    }

    const speakKey = buildCommentarySpeakKey(
      data?.generatedAt,
      activeEntry.date,
      activeEntry.commentary,
    );
    if (lastSpokenKeyRef.current === speakKey) {
      return;
    }
    lastSpokenKeyRef.current = speakKey;
    speakText(activeEntry.commentary, ttsVoiceUri);
  }, [
    enabled,
    ttsEnabled,
    ttsVoiceUri,
    isPlaying,
    isStale,
    isFetching,
    activeEntry,
    data?.generatedAt,
    lastSpokenKeyRef,
  ]);

  useEffect(() => {
    return () => {
      cancelSpeech();
    };
  }, []);

  const handleSpeakerClick = () => {
    if (ttsEnabled) {
      cancelSpeech();
      lastSpokenKeyRef.current = null;
      onSetTtsEnabled(false);
      setVoiceMenuOpen(false);
      return;
    }

    // Enabling TTS: refresh locale voices, turn on, and open voice picker popup
    const latest = getLocaleVoices();
    setVoiceList(latest);
    onSetTtsEnabled(true);
    setVoiceMenuOpen(latest.voices.length > 0);

    // Synchronously unlock browser speech synthesis inside this click gesture
    if (isPlaying && !isStale && !isFetching && activeEntry?.commentary) {
      lastSpokenKeyRef.current = buildCommentarySpeakKey(
        data?.generatedAt,
        activeEntry.date,
        activeEntry.commentary,
      );
      speakText(activeEntry.commentary, ttsVoiceUri);
    }
  };

  const handleChooseVoice = (nextUri: string | null) => {
    onSelectVoiceUri(nextUri);
    setVoiceMenuOpen(false);
    // Audition chosen voice immediately inside the user gesture (also unlocks TTS)
    const canSpeakEntry = isPlaying && !isStale && !isFetching && Boolean(activeEntry?.commentary);
    const previewText = canSpeakEntry && activeEntry ? activeEntry.commentary : 'Ready to race!';
    if (canSpeakEntry && activeEntry) {
      lastSpokenKeyRef.current = buildCommentarySpeakKey(
        data?.generatedAt,
        activeEntry.date,
        activeEntry.commentary,
      );
    }
    speakText(previewText, nextUri);
  };

  if (!enabled) {
    return (
      <div className={`${styles.ticker} ${styles.collapsed}`}>
        <button
          type="button"
          className={styles.enableBtn}
          onClick={onToggleEnabled}
        >
          <MicIcon size={15} />
          <span>Enable AI Race Announcer</span>
        </button>
      </div>
    );
  }

  const isNotConfigured = error instanceof ApiError && error.status === 503;
  const showUpdating = isFetching && (isStale || !data);
  const showStalePrompt = isStale && !isFetching;

  return (
    <div
      className={`${styles.ticker}${isFinalDay && activeEntry && !isStale && !showUpdating ? ` ${styles.finalDay}` : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className={styles.body}>
        {isPending && !data && (
          <p className={`${styles.text} muted`}>Tuning into the velodrome booth...</p>
        )}

        {!isPending && showUpdating && (
          <p className={`${styles.text} muted`}>Updating race commentary...</p>
        )}

        {!isPending && !showUpdating && showStalePrompt && (
          <div className={styles.staleBanner}>
            <p className={`${styles.text} muted`}>
              Standings changed — commentary is out of date.
            </p>
            <button
              type="button"
              className={`btn btn-secondary btn-xs ${styles.updateBtn}`}
              onClick={onRefreshCommentary}
            >
              Update
            </button>
          </div>
        )}

        {!isPending && !showUpdating && !showStalePrompt && isNotConfigured && (
          <p className={`${styles.text} muted`}>
            AI Announcer ready once your Gemini key is saved in SSM (
            <code className="code-inline">/activity-racer/gemini-api-key</code>).
          </p>
        )}

        {!isPending && !showUpdating && !showStalePrompt && Boolean(error) && !isNotConfigured && (
          <p className={`${styles.text} muted`}>
            {error instanceof Error ? error.message : 'Race commentary temporarily unavailable.'}
          </p>
        )}

        {!showUpdating && !showStalePrompt && activeEntry && (
          <p key={activeEntry.date} className={`${styles.text} ${styles.fadeIn}`}>
            {activeEntry.commentary}
          </p>
        )}
      </div>

      <div className={styles.actions} ref={actionsWrapRef}>
        <button
          type="button"
          className={`btn btn-secondary btn-xs ${styles.iconBtn}`}
          onClick={() => {
            setVoiceMenuOpen(false);
            onToggleEnabled();
          }}
          aria-label="Hide AI Race Announcer"
          title="Hide commentary"
        >
          <CloseIcon size={14} />
        </button>

        {hasSpeechSynthesis() && (
          <button
            type="button"
            className={`btn btn-secondary btn-xs ${styles.iconBtn}${ttsEnabled ? ` ${styles.active}` : ''}`}
            onClick={handleSpeakerClick}
            aria-pressed={ttsEnabled}
            aria-expanded={voiceMenuOpen}
            aria-haspopup="menu"
            aria-label={ttsEnabled ? 'Disable read aloud' : 'Enable read aloud and choose voice'}
            title={ttsEnabled ? 'Mute read aloud (click again to pick voice)' : 'Read aloud & choose voice'}
          >
            {ttsEnabled ? <VolumeOnIcon size={14} /> : <VolumeOffIcon size={14} />}
          </button>
        )}

        {voiceMenuOpen && voiceList.voices.length > 0 && (
          <div
            className={styles.voicePopover}
            role="menu"
            aria-label={`Select voice (${voiceList.locale})`}
          >
            <div className={styles.voicePopoverHead}>
              <span>Voice ({voiceList.locale})</span>
              <button
                type="button"
                className={styles.voicePopoverClose}
                onClick={() => setVoiceMenuOpen(false)}
                aria-label="Close voice menu"
              >
                Done
              </button>
            </div>
            <div className={styles.voicePopoverList}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={ttsVoiceUri === null}
                className={`${styles.voiceOptionBtn}${ttsVoiceUri === null ? ` ${styles.selected}` : ''}`}
                onClick={() => handleChooseVoice(null)}
              >
                <span className={styles.voiceOptionName}>Browser Default</span>
              </button>
              {voiceList.voices.map((voice) => {
                const isSelected = ttsVoiceUri === voice.voiceURI;
                return (
                  <button
                    key={voice.voiceURI}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    className={`${styles.voiceOptionBtn}${isSelected ? ` ${styles.selected}` : ''}`}
                    onClick={() => handleChooseVoice(voice.voiceURI)}
                  >
                    <span className={styles.voiceOptionName}>{voice.name}</span>
                    <span className={styles.voiceOptionLang}>{voice.lang}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
