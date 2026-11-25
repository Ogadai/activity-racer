import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getTodayIsoDate, type RaceRange } from '@activity-racer/shared';
import { useGroups, useRace } from '../api/queries';

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

export function RacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [range, setRange] = useState<RaceRange>('daily');
  const [date, setDate] = useState<string>(() => getTodayIsoDate());

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

  const handleGroupChange = (nextGroupId: string) => {
    setSearchParams({ group: nextGroupId });
  };

  return (
    <div className="page-stack">
      <div className="page-header">
        <div>
          <h1>Live Race Leaderboard</h1>
          <p className="subtitle">
            Phase 3 wired table view · Visual bike race track arrives in Phase 4.
          </p>
        </div>
        {raceQuery.data && (
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

          <section className="card">
            {raceQuery.isPending && <p className="muted">Loading standings...</p>}

            {raceQuery.isError && (
              <div className="alert alert-error">
                {raceQuery.error instanceof Error
                  ? raceQuery.error.message
                  : 'Failed to load race standings.'}
              </div>
            )}

            {raceQuery.data && (
              <>
                <div className="section-head">
                  <div>
                    <h2>{raceQuery.data.group.name}</h2>
                    <p className="muted small">
                      {raceQuery.data.range === 'weekly'
                        ? `Week of ${raceQuery.data.startDate} to ${raceQuery.data.endDate}`
                        : `Daily race for ${raceQuery.data.date}`}
                      {' · Invite code: '}
                      <code className="code-inline">{raceQuery.data.group.inviteCode}</code>
                    </p>
                  </div>
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
                      {raceQuery.data.standings.map((row) => (
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
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
