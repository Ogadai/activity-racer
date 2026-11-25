import { useEffect, useState, type FormEvent } from 'react';
import {
  BIKE_COLOR_PALETTE,
  HEX_COLOR_REGEX,
  PLAYER_SLUG_REGEX,
} from '@activity-racer/shared';
import { useProfile, useUpdateProfile } from '../api/queries';
import { useAuth } from '../auth/AuthContext';
import styles from './SettingsPage.module.css';

function buildHomeAssistantRestCommandYaml(
  statsUrl: string,
  playerSlug: string,
  apiKey: string,
  useSecretsRef: boolean,
): string {
  const keyLine = useSecretsRef ? '!secret activity_racer_api_key' : `"${apiKey}"`;
  return `# configuration.yaml
rest_command:
  activity_racer_sync:
    url: "${statsUrl}"
    method: POST
    content_type: "application/json"
    headers:
      x-api-key: ${keyLine}
    payload: >-
      {
        "playerSlug": "${playerSlug}",
        "steps": {{ states('sensor.your_phone_steps') | int(0) }},
        "activeCalories": {{ states('sensor.your_active_calories') | float(0) | round(1) }},
        "source": "home-assistant"
      }`;
}

function buildHomeAssistantAutomationYaml(): string {
  return `# automations.yaml
- alias: "Activity Racer - Sync Daily Activity"
  trigger:
    - platform: time_pattern
      minutes: "/30"
    - platform: time
      at: "23:55:00"
  action:
    - service: rest_command.activity_racer_sync`;
}

export function SettingsPage() {
  const { config } = useAuth();
  const profileQuery = useProfile();
  const updateProfile = useUpdateProfile();

  const [displayName, setDisplayName] = useState('');
  const [playerSlug, setPlayerSlug] = useState('');
  const [bikeColor, setBikeColor] = useState('#5288b5');
  const [dailyStepTarget, setDailyStepTarget] = useState('10000');
  const [dailyCalorieTarget, setDailyCalorieTarget] = useState('500');
  const [stepWeightPct, setStepWeightPct] = useState(50);

  const [saveMessage, setSaveMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [useSecretsRef, setUseSecretsRef] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!profileQuery.data) {
      return;
    }
    const p = profileQuery.data;
    setDisplayName(p.displayName);
    setPlayerSlug(p.playerSlug);
    setBikeColor(p.bikeColor);
    setDailyStepTarget(String(p.dailyStepTarget));
    setDailyCalorieTarget(String(p.dailyCalorieTarget));
    setStepWeightPct(Math.round(p.stepWeight * 100));
  }, [profileQuery.data]);

  const calorieWeightPct = 100 - stepWeightPct;

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedTarget(key);
      setTimeout(() => setCopiedTarget((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaveMessage(null);

    const normalizedSlug = playerSlug.trim().toLowerCase();
    if (!PLAYER_SLUG_REGEX.test(normalizedSlug)) {
      setSaveMessage({
        kind: 'err',
        text: 'Player slug must be 2–32 lowercase letters, numbers, or hyphens and start with a letter or number.',
      });
      return;
    }

    const normalizedColor = bikeColor.trim().toLowerCase();
    if (!HEX_COLOR_REGEX.test(normalizedColor)) {
      setSaveMessage({
        kind: 'err',
        text: 'Bike color must be a valid 6-digit hex color (e.g. #5288b5).',
      });
      return;
    }

    const stepsNum = Number(dailyStepTarget);
    const calsNum = Number(dailyCalorieTarget);
    const stepWeight = Math.round(stepWeightPct) / 100;
    const calorieWeight = Math.round((100 - stepWeightPct)) / 100;

    try {
      await updateProfile.mutateAsync({
        displayName: displayName.trim(),
        playerSlug: normalizedSlug,
        bikeColor: normalizedColor,
        dailyStepTarget: stepsNum,
        dailyCalorieTarget: calsNum,
        stepWeight,
        calorieWeight,
      });
      setSaveMessage({ kind: 'ok', text: 'Profile and handicapping targets saved.' });
    } catch (err) {
      setSaveMessage({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to update settings.',
      });
    }
  };

  const handleRotateKey = async () => {
    setSaveMessage(null);
    try {
      await updateProfile.mutateAsync({ rotateWebhookApiKey: true });
      setConfirmRotate(false);
      setRevealKey(true);
      setSaveMessage({
        kind: 'ok',
        text: 'Webhook API key rotated. Remember to update your Home Assistant configuration.',
      });
    } catch (err) {
      setSaveMessage({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to rotate webhook API key.',
      });
    }
  };

  if (profileQuery.isPending) {
    return (
      <div className="card">
        <p className="muted">Loading your profile...</p>
      </div>
    );
  }

  if (profileQuery.isError || !profileQuery.data) {
    return (
      <div className="alert alert-error">
        {profileQuery.error instanceof Error
          ? profileQuery.error.message
          : 'Unable to load player profile.'}
      </div>
    );
  }

  const profile = profileQuery.data;
  const statsUrl = config ? `${config.apiUrl}/stats` : '/api/stats';
  const maskedKey = `${profile.webhookApiKey.slice(0, 7)}${'•'.repeat(20)}${profile.webhookApiKey.slice(-4)}`;
  const restCommandYaml = buildHomeAssistantRestCommandYaml(
    statsUrl,
    profile.playerSlug,
    profile.webhookApiKey,
    useSecretsRef,
  );
  const automationYaml = buildHomeAssistantAutomationYaml();
  const curlSnippet = `curl -X POST "${statsUrl}" \\\n  -H "Content-Type: application/json" \\\n  -H "x-api-key: ${profile.webhookApiKey}" \\\n  -d '{"playerSlug":"${profile.playerSlug}","steps":6500,"activeCalories":320}'`;

  return (
    <div className="page-stack">
      <div className="page-header">
        <div>
          <h1>Settings &amp; Home Assistant Sync</h1>
          <p className="subtitle">
            Customize your racer identity, fair handicapping goals, and Home Assistant webhook.
          </p>
        </div>
      </div>

      {saveMessage && (
        <div
          className={saveMessage.kind === 'ok' ? 'alert alert-success' : 'alert alert-error'}
          role="status"
        >
          {saveMessage.text}
        </div>
      )}

      <section className="card">
        <h2>Racer Profile &amp; Handicapping</h2>
        <form onSubmit={(e) => void handleSave(e)} className="form-stack">
          <div className="two-col-grid">
            <label className="field">
              <span>Display Name</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                minLength={1}
                maxLength={40}
                required
              />
            </label>

            <label className="field">
              <span>Player Slug (unique webhook ID)</span>
              <input
                type="text"
                value={playerSlug}
                onChange={(e) => setPlayerSlug(e.target.value.toLowerCase())}
                minLength={2}
                maxLength={32}
                required
                className="mono-input"
              />
            </label>
          </div>

          <div className="field">
            <span>Bike Color</span>
            <div className={styles.swatchRow}>
              {BIKE_COLOR_PALETTE.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className={
                    bikeColor.toLowerCase() === hex.toLowerCase()
                      ? `${styles.colorSwatch} ${styles.selected}`
                      : styles.colorSwatch
                  }
                  style={{ backgroundColor: hex }}
                  onClick={() => setBikeColor(hex)}
                  aria-label={`Select color ${hex}`}
                  title={hex}
                />
              ))}
              <input
                type="color"
                value={HEX_COLOR_REGEX.test(bikeColor) ? bikeColor : '#5288b5'}
                onChange={(e) => setBikeColor(e.target.value)}
                aria-label="Custom bike color"
                className={styles.colorPickerInput}
              />
              <code className="code-inline">{bikeColor}</code>
            </div>
          </div>

          <div className="two-col-grid">
            <label className="field">
              <span>Daily Step Target</span>
              <input
                type="number"
                min={100}
                max={200000}
                step={100}
                value={dailyStepTarget}
                onChange={(e) => setDailyStepTarget(e.target.value)}
                required
              />
            </label>

            <label className="field">
              <span>Daily Active Calorie Target (kcal)</span>
              <input
                type="number"
                min={10}
                max={20000}
                step={10}
                value={dailyCalorieTarget}
                onChange={(e) => setDailyCalorieTarget(e.target.value)}
                required
              />
            </label>
          </div>

          <div className="field">
            <div className={styles.sliderHead}>
              <span>Metric Weighting (always sums to 100%)</span>
              <strong>
                Steps {stepWeightPct}% · Active Calories {calorieWeightPct}%
              </strong>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={stepWeightPct}
              onChange={(e) => setStepWeightPct(Number(e.target.value))}
            />
            <p className={styles.formulaPreview}>
              Formula: <code>{stepWeightPct}%</code> × (steps ÷{' '}
              <code>{Number(dailyStepTarget || 0).toLocaleString()}</code>) +{' '}
              <code>{calorieWeightPct}%</code> × (active kcal ÷{' '}
              <code>{Number(dailyCalorieTarget || 0).toLocaleString()}</code>)
            </p>
          </div>

          <div>
            <button type="submit" className="btn btn-primary" disabled={updateProfile.isPending}>
              {updateProfile.isPending ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2>Home Assistant Webhook Setup</h2>
        <p className="muted small">
          Home Assistant posts your daily steps and active calories directly to this endpoint using
          your personal API key.
        </p>

        <div className={styles.webhookMeta}>
          <div className={styles.webhookRow}>
            <span className={styles.webhookLabel}>Endpoint</span>
            <div className="copy-row">
              <code className="code-inline">{statsUrl}</code>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={() => void copyText('url', statsUrl)}
              >
                {copiedTarget === 'url' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div className={styles.webhookRow}>
            <span className={styles.webhookLabel}>x-api-key</span>
            <div className="copy-row">
              <code className="code-inline">
                {revealKey ? profile.webhookApiKey : maskedKey}
              </code>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={() => setRevealKey((v) => !v)}
              >
                {revealKey ? 'Hide' : 'Reveal'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={() => void copyText('key', profile.webhookApiKey)}
              >
                {copiedTarget === 'key' ? 'Copied!' : 'Copy'}
              </button>
              {!confirmRotate ? (
                <button
                  type="button"
                  className="btn btn-danger-outline btn-xs"
                  onClick={() => setConfirmRotate(true)}
                >
                  Rotate Key
                </button>
              ) : (
                <span className={styles.inlineConfirm}>
                  <button
                    type="button"
                    className="btn btn-danger btn-xs"
                    disabled={updateProfile.isPending}
                    onClick={() => void handleRotateKey()}
                  >
                    Confirm Rotate
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    onClick={() => setConfirmRotate(false)}
                  >
                    Cancel
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className={styles.yamlSection}>
          <div className="section-head">
            <h3>1. Add REST Command</h3>
            <div className={styles.inlineControls}>
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={useSecretsRef}
                  onChange={(e) => setUseSecretsRef(e.target.checked)}
                />
                <span>Use Home Assistant <code>!secret</code> (recommended)</span>
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={() => void copyText('rest', restCommandYaml)}
              >
                {copiedTarget === 'rest' ? 'Copied!' : 'Copy YAML'}
              </button>
            </div>
          </div>
          <pre className={styles.codeBlock}>
            <code>{restCommandYaml}</code>
          </pre>
        </div>

        <div className={styles.yamlSection}>
          <div className="section-head">
            <h3>2. Schedule Sync Automation</h3>
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => void copyText('auto', automationYaml)}
            >
              {copiedTarget === 'auto' ? 'Copied!' : 'Copy YAML'}
            </button>
          </div>
          <pre className={styles.codeBlock}>
            <code>{automationYaml}</code>
          </pre>
        </div>

        <div className={styles.yamlSection}>
          <div className="section-head">
            <h3>3. Quick Test via curl</h3>
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => void copyText('curl', curlSnippet)}
            >
              {copiedTarget === 'curl' ? 'Copied!' : 'Copy curl'}
            </button>
          </div>
          <pre className={styles.codeBlock}>
            <code>{curlSnippet}</code>
          </pre>
        </div>
      </section>
    </div>
  );
}
