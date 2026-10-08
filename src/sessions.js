'use strict';

// Discovers live Claude Code sessions.
//
// Claude Code drops one JSON file per session into ~/.claude/sessions, keyed by
// pid. Those files are never cleaned up, so the directory accumulates hundreds of
// records for processes that exited long ago. Liveness is decided per record:
// the pid must exist *and* its kernel start time must still match the `procStart`
// written when the session registered, which rules out a recycled pid.

const fs = require('fs');
const path = require('path');
const { SESSIONS_DIR } = require('./paths');

// Field 22 of /proc/<pid>/stat, counted from the closing paren of comm so that a
// process name containing spaces or parens cannot shift the offsets.
function procStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19];
  } catch {
    return null;
  }
}

function isAlive(rec) {
  if (!rec || typeof rec.pid !== 'number') return false;
  const start = procStartTime(rec.pid);
  if (start !== null) {
    return rec.procStart ? start === String(rec.procStart) : true;
  }
  // No procfs (macOS, BSD): fall back to a signal-0 probe. EPERM means the
  // process is alive but owned by someone else.
  try {
    process.kill(rec.pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// cwd -> { repo, worktree }. Resolving this walks the filesystem, and a session's
// cwd rarely changes, so it is worth caching.
const repoCache = new Map();

function repoOf(cwd) {
  if (!cwd) return { repo: '', worktree: '' };
  const cached = repoCache.get(cwd);
  if (cached) return cached;

  // A worktree lives at <repo>/.claude/worktrees/<name>; its own `.git` is a
  // file pointing back at the real repository, so strip that suffix first and
  // the walk below lands on the repository everyone would name.
  const [base, rest] = cwd.split('/.claude/worktrees/');
  const worktree = rest ? rest.split('/')[0] : '';

  let dir = base;
  let repo = '';
  for (let depth = 0; depth < 40 && dir && dir !== '/' && dir !== '.'; depth += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      repo = path.basename(dir);
      break;
    }
    dir = path.dirname(dir);
  }

  const result = { repo: repo || path.basename(base) || '', worktree };
  repoCache.set(cwd, result);
  return result;
}

function readAll() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }

  const live = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
    } catch {
      continue; // half-written or stale-locked file; it will be picked up next scan
    }
    if (!rec.sessionId || !isAlive(rec)) continue;
    const { repo, worktree } = repoOf(rec.cwd);
    live.push({
      sessionId: rec.sessionId,
      pid: rec.pid,
      name: rec.name || rec.sessionId.slice(0, 8),
      repo,
      worktree,
      cwd: rec.cwd || '',
      status: rec.status || 'unknown',
      waitingFor: rec.waitingFor || null,
      kind: rec.kind || 'interactive',
      entrypoint: rec.entrypoint || '',
      version: rec.version || '',
      startedAt: rec.startedAt || null,
      updatedAt: rec.updatedAt || rec.startedAt || null,
    });
  }
  return live;
}

module.exports = { readAll, isAlive };
