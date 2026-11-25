import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useCreateGroup, useGroups, useJoinGroup } from '../api/queries';
import styles from './GroupsPage.module.css';

export function GroupsPage() {
  const groupsQuery = useGroups();
  const createGroup = useCreateGroup();
  const joinGroup = useJoinGroup();

  const [newGroupName, setNewGroupName] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const trimmed = newGroupName.trim();
    if (!trimmed) {
      return;
    }
    try {
      const created = await createGroup.mutateAsync({ name: trimmed });
      setNewGroupName('');
      setFeedback({
        kind: 'ok',
        text: `Created "${created.name}". Share invite code ${created.inviteCode} with friends & family!`,
      });
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to create group.',
      });
    }
  };

  const handleJoin = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const normalized = inviteInput.trim().toUpperCase().replace(/\s+/g, '');
    if (!normalized) {
      return;
    }
    try {
      const joined = await joinGroup.mutateAsync({ inviteCode: normalized });
      setInviteInput('');
      setFeedback({
        kind: 'ok',
        text: `Joined "${joined.name}"!`,
      });
    } catch (err) {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to join group.',
      });
    }
  };

  const copyCode = async (groupId: string, inviteCode: string) => {
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopiedId(groupId);
      setTimeout(() => setCopiedId((prev) => (prev === groupId ? null : prev)), 2000);
    } catch {
      // Ignore clipboard failures
    }
  };

  const groups = groupsQuery.data?.groups ?? [];

  return (
    <div className="page-stack">
      <div className="page-header">
        <div>
          <h1>Racing Groups</h1>
          <p className="subtitle">
            Create a family or friends group, or join an existing one with an 8-character invite
            code.
          </p>
        </div>
      </div>

      {feedback && (
        <div
          className={feedback.kind === 'ok' ? 'alert alert-success' : 'alert alert-error'}
          role="status"
        >
          {feedback.text}
        </div>
      )}

      <div className="two-col-grid">
        <section className="card">
          <h2>Create a Group</h2>
          <p className="muted small">
            Start a new leaderboard and get an invite code to share.
          </p>
          <form onSubmit={(e) => void handleCreate(e)} className="form-stack">
            <label className="field">
              <span>Group Name</span>
              <input
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="e.g. Sunday Riders or Family Fitness"
                minLength={1}
                maxLength={60}
                required
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={createGroup.isPending || newGroupName.trim().length === 0}
            >
              {createGroup.isPending ? 'Creating...' : 'Create Group'}
            </button>
          </form>
        </section>

        <section className="card">
          <h2>Join with Invite Code</h2>
          <p className="muted small">
            Enter the code shared by a group owner to join their race.
          </p>
          <form onSubmit={(e) => void handleJoin(e)} className="form-stack">
            <label className="field">
              <span>Invite Code</span>
              <input
                type="text"
                value={inviteInput}
                onChange={(e) => setInviteInput(e.target.value.toUpperCase())}
                placeholder="e.g. ABCD2345"
                minLength={4}
                maxLength={32}
                required
                className="mono-input"
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={joinGroup.isPending || inviteInput.trim().length < 4}
            >
              {joinGroup.isPending ? 'Joining...' : 'Join Group'}
            </button>
          </form>
        </section>
      </div>

      <section className="card">
        <div className="section-head">
          <h2>Your Groups ({groups.length})</h2>
          {groupsQuery.isFetching && !groupsQuery.isPending && (
            <span className="muted small">Refreshing...</span>
          )}
        </div>

        {groupsQuery.isPending && <p className="muted">Loading your groups...</p>}

        {groupsQuery.isError && (
          <div className="alert alert-error">
            {groupsQuery.error instanceof Error
              ? groupsQuery.error.message
              : 'Failed to load groups.'}
          </div>
        )}

        {groupsQuery.isSuccess && groups.length === 0 && (
          <div className="empty-state">
            <p>You haven&apos;t joined any groups yet.</p>
            <p className="muted small">
              Create your first group above or enter an invite code from a friend.
            </p>
          </div>
        )}

        {groups.length > 0 && (
          <div className={styles.groupList}>
            {groups.map((group) => (
              <article key={group.groupId} className={styles.groupItem}>
                <div>
                  <div className={styles.groupTitleRow}>
                    <h3>{group.name}</h3>
                    <span className={group.role === 'OWNER' ? 'pill pill-blue' : 'pill'}>
                      {group.role}
                    </span>
                  </div>
                  <div className={styles.groupMetaRow}>
                    <span className="muted small">Invite code:</span>
                    <code className="code-inline">{group.inviteCode}</code>
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => void copyCode(group.groupId, group.inviteCode)}
                    >
                      {copiedId === group.groupId ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
                <div>
                  <Link
                    to={`/race?group=${encodeURIComponent(group.groupId)}`}
                    className="btn btn-primary btn-sm"
                  >
                    Open Race →
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
