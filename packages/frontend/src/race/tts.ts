export interface LocaleVoiceList {
  locale: string;
  voices: SpeechSynthesisVoice[];
}

export function hasSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function normalizeLang(lang: string): string {
  return lang.trim().replace(/_/g, '-').toLowerCase();
}

export function getUserLocale(): string {
  if (typeof navigator === 'undefined') {
    return 'en-GB';
  }
  return navigator.language || navigator.languages?.[0] || 'en-GB';
}

/**
 * Returns browser TTS voices filtered to the user's locale (e.g. "en-GB"),
 * falling back to base language ("en") only if no exact locale voices exist.
 */
export function getLocaleVoices(): LocaleVoiceList {
  const locale = getUserLocale();
  if (!hasSpeechSynthesis()) {
    return { locale, voices: [] };
  }

  const all = window.speechSynthesis.getVoices();
  if (all.length === 0) {
    return { locale, voices: [] };
  }

  const normLocale = normalizeLang(locale);
  const baseLang = normLocale.split('-')[0];

  let matched = all.filter((v) => normalizeLang(v.lang) === normLocale);
  if (matched.length === 0 && baseLang) {
    matched = all.filter((v) => {
      const vl = normalizeLang(v.lang);
      return vl === baseLang || vl.startsWith(`${baseLang}-`);
    });
  }
  if (matched.length === 0) {
    matched = [...all];
  }

  matched.sort((a, b) => {
    if (a.default !== b.default) return a.default ? -1 : 1;
    if (a.localService !== b.localService) return a.localService ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { locale, voices: matched };
}

export function resolveVoice(voiceURI: string | null): SpeechSynthesisVoice | null {
  if (!hasSpeechSynthesis()) {
    return null;
  }
  const all = window.speechSynthesis.getVoices();
  if (voiceURI) {
    const exact = all.find((v) => v.voiceURI === voiceURI);
    if (exact) {
      return exact;
    }
  }
  const { voices } = getLocaleVoices();
  return voices[0] ?? null;
}

export function subscribeVoicesChanged(callback: () => void): () => void {
  if (!hasSpeechSynthesis()) {
    return () => {};
  }
  window.speechSynthesis.addEventListener('voiceschanged', callback);
  return () => {
    window.speechSynthesis.removeEventListener('voiceschanged', callback);
  };
}

export function speakText(text: string, voiceURI: string | null): void {
  if (!hasSpeechSynthesis() || !text.trim()) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.resume();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = resolveVoice(voiceURI);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = getUserLocale();
    }
    utterance.rate = 1.02;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Ignore browser speech synthesis failures
  }
}

export function cancelSpeech(): void {
  if (!hasSpeechSynthesis()) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignore
  }
}
