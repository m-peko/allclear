'use strict';

// Everything rendered here comes from tool inputs of live Claude Code sessions.
// It is built with createElement/textContent only — never innerHTML — so a tool
// argument containing markup can't execute in the dashboard.

const el = {
  sessions: document.getElementById('sessions'),
  statSessions: document.getElementById('stat-sessions'),
  statPending: document.getElementById('stat-pending'),
  approveAll: document.getElementById('approve-all'),
  autoApprove: document.getElementById('auto-approve'),
  conn: document.getElementById('conn'),
  activityPanel: document.getElementById('activity-panel'),
  activity: document.getElementById('activity'),
};

let state = { sessions: [], pendingCount: 0, autoApprove: false, activity: [] };
let seenRequestIds = new Set();
let busyIds = new Set();

// ------------------------------------------------------------------ helpers

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function truncate(value, max = 4000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
  return text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text;
}

function shortPath(p) {
  if (!p) return '';
  return p.replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');
}

function relTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function countdown(expiresAt) {
  const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return { text: `${m}:${String(s).padStart(2, '0')}`, urgent: left < 60 };
}

// ------------------------------------------------------- tool input rendering

// Returns { summary, lines: [{ text, cls }] } — a one-line gist plus the detail
// a human needs to judge the call before approving it.
function describeTool(name, input) {
  const i = input || {};
  const line = (text, cls) => ({ text: text ?? '', cls: cls || '' });

  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return { summary: i.description || 'shell command', lines: [line(truncate(i.command))] };

    case 'Read':
      return { summary: shortPath(i.file_path), lines: [line(shortPath(i.file_path), 'path')] };

    case 'Write':
      return {
        summary: shortPath(i.file_path),
        lines: [line(shortPath(i.file_path), 'path'), line(truncate(i.content, 1500))],
      };

    case 'Edit': {
      const lines = [line(shortPath(i.file_path), 'path')];
      String(i.old_string ?? '')
        .split('\n')
        .forEach((l) => lines.push(line(`- ${l}`, 'del')));
      String(i.new_string ?? '')
        .split('\n')
        .forEach((l) => lines.push(line(`+ ${l}`, 'add')));
      return { summary: shortPath(i.file_path), lines };
    }

    case 'WebFetch':
      return { summary: i.url || '', lines: [line(i.url, 'path'), line(i.prompt || '')] };

    case 'WebSearch':
      return { summary: i.query || '', lines: [line(i.query || '')] };

    case 'Grep':
      return {
        summary: `${i.pattern || ''} in ${shortPath(i.path) || '.'}`,
        lines: [line(`pattern: ${i.pattern || ''}`), line(`path:    ${shortPath(i.path) || '.'}`)],
      };

    case 'Glob':
      return { summary: i.pattern || '', lines: [line(i.pattern || '')] };

    case 'Task':
    case 'Agent':
      return {
        summary: i.description || i.subagent_type || 'subagent',
        lines: [line(truncate(i.prompt, 1200))],
      };

    default:
      return { summary: '', lines: [line(truncate(i))] };
  }
}

// ------------------------------------------------------------------- actions

async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return await res.json();
  } catch {
    return { ok: false };
  }
}

function decide(id, behavior, remember) {
  if (busyIds.has(id)) return;
  busyIds.add(id);
  render(); // grey the row out immediately; the SSE push removes it
  post('/api/decide', { id, behavior, remember }).finally(() => busyIds.delete(id));
}

function approveAll(sessionId) {
  const ids = state.sessions.flatMap((s) =>
    !sessionId || s.sessionId === sessionId ? s.pending.map((p) => p.id) : []
  );
  ids.forEach((id) => busyIds.add(id));
  render();
  post('/api/approve-all', sessionId ? { sessionId } : {}).finally(() => {
    ids.forEach((id) => busyIds.delete(id));
  });
}

el.approveAll.addEventListener('click', () => approveAll(null));

el.autoApprove.addEventListener('change', (event) => {
  const enabled = event.target.checked;
  if (enabled) {
    const ok = window.confirm(
      'Auto-approve grants every permission request from every session the moment it ' +
        'arrives — including commands that delete files or reach the network. ' +
        'You will not see them first.\n\nTurn it on?'
    );
    if (!ok) {
      event.target.checked = false;
      return;
    }
  }
  post('/api/auto-approve', { enabled });
});

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'a' || event.key === 'A') {
    if (state.pendingCount > 0) approveAll(null);
  }
});

// ------------------------------------------------------------------ rendering

function renderRequest(request) {
  const wrap = node('div', 'req');
  const { summary, lines } = describeTool(request.toolName, request.toolInput);

  const head = node('div', 'req-head');
  head.append(node('span', 'tool', request.toolName));
  if (summary) head.append(node('span', 'req-desc', summary));
  else head.append(node('span', 'req-desc'));

  const timer = countdown(request.expiresAt);
  const clock = node('span', `countdown${timer.urgent ? ' urgent' : ''}`, timer.text);
  clock.title = 'Time left before compa stops holding this request and Claude Code falls back to the terminal prompt.';
  clock.dataset.expires = String(request.expiresAt);
  head.append(clock);
  wrap.append(head);

  const pre = node('pre', 'body');
  lines.forEach((l, index) => {
    if (index) pre.append(document.createTextNode('\n'));
    if (l.cls) pre.append(node('span', l.cls, l.text));
    else pre.append(document.createTextNode(l.text));
  });
  wrap.append(pre);

  const actions = node('div', 'req-actions');
  const working = busyIds.has(request.id);

  const allow = node('button', 'btn btn-allow', working ? 'Approving…' : 'Approve');
  allow.disabled = working;
  allow.addEventListener('click', () => decide(request.id, 'allow', false));
  actions.append(allow);

  if (request.canRemember) {
    const always = node('button', 'btn', 'Always allow');
    always.title = `Approve and add a permanent allow rule: ${request.rememberLabel || ''}`;
    always.disabled = working;
    always.addEventListener('click', () => decide(request.id, 'allow', true));
    actions.append(always);
  }

  actions.append(node('div', 'spacer'));

  const deny = node('button', 'btn btn-deny', 'Deny');
  deny.disabled = working;
  deny.addEventListener('click', () => decide(request.id, 'deny', false));
  actions.append(deny);

  wrap.append(actions);
  return wrap;
}

function renderSession(session) {
  const card = node('div', `card${session.pending.length ? ' has-pending' : ''}`);

  const head = node('div', 'card-head');
  const status = session.pending.length ? 'waiting' : session.status;
  const dot = node('span', `dot ${status}`);
  dot.title = status;
  head.append(dot);
  head.append(node('span', 'card-name', session.name));

  const meta = node('span', 'card-meta', shortPath(session.cwd));
  meta.title = session.cwd;
  head.append(meta);

  if (session.pending.length) {
    head.append(node('span', 'badge hot', `${session.pending.length} waiting`));
    const approve = node('button', 'btn btn-allow', 'Approve these');
    approve.addEventListener('click', () => approveAll(session.sessionId));
    head.append(approve);
  } else {
    head.append(node('span', 'badge', session.status));
  }

  card.append(head);
  session.pending.forEach((request) => card.append(renderRequest(request)));

  if (session.notice) {
    const notice = node('div', 'notice', session.notice.message);
    notice.append(
      node(
        'small',
        null,
        'Claude Code reported this prompt but it cannot be answered from here — switch to that terminal.'
      )
    );
    card.append(notice);
  }

  return card;
}

function renderActivity() {
  el.activity.replaceChildren();
  if (!state.activity.length) {
    el.activityPanel.hidden = true;
    return;
  }
  el.activityPanel.hidden = false;

  for (const entry of state.activity) {
    const li = node('li');
    const verb =
      entry.behavior === 'allow'
        ? entry.remembered
          ? 'always'
          : entry.via === 'auto-approve'
            ? 'auto'
            : 'allowed'
        : entry.behavior === 'deny'
          ? 'denied'
          : 'released';
    li.append(node('span', `verb ${entry.behavior}`, verb));
    li.append(node('span', 'who', entry.sessionName || ''));
    const { summary } = describeTool(entry.toolName, entry.toolInput);
    li.append(node('span', 'what', `${entry.toolName}${summary ? ` · ${summary}` : ''}`));
    li.append(node('span', 'who', relTime(entry.at)));
    el.activity.append(li);
  }
}

function render() {
  const pendingCount = state.pendingCount || 0;

  el.statSessions.textContent = String(state.sessions.length);
  el.statPending.textContent = String(pendingCount);
  el.statPending.parentElement.classList.toggle('hot', pendingCount > 0);

  el.approveAll.disabled = pendingCount === 0;
  el.approveAll.replaceChildren(
    document.createTextNode(pendingCount ? `Approve all ${pendingCount}` : 'Approve all')
  );
  el.approveAll.append(node('kbd', null, 'A'));

  el.autoApprove.checked = Boolean(state.autoApprove);

  document.title = pendingCount ? `(${pendingCount}) compa` : 'compa';

  el.sessions.replaceChildren();
  if (!state.sessions.length) {
    const empty = node('div', 'empty');
    empty.append(node('strong', null, 'No Claude Code sessions running'));
    empty.append(
      node('span', null, 'Start a session and it will appear here within a second.')
    );
    el.sessions.append(empty);
  } else {
    state.sessions.forEach((session) => el.sessions.append(renderSession(session)));
  }

  renderActivity();
}

// Keep the per-request countdowns moving without re-rendering the whole tree.
setInterval(() => {
  document.querySelectorAll('.countdown[data-expires]').forEach((element) => {
    const timer = countdown(Number(element.dataset.expires));
    element.textContent = timer.text;
    element.classList.toggle('urgent', timer.urgent);
  });
}, 1000);

// --------------------------------------------------------------- live updates

function notifyNew(next) {
  const ids = new Set();
  for (const session of next.sessions) for (const request of session.pending) ids.add(request.id);

  const fresh = [...ids].filter((id) => !seenRequestIds.has(id));
  seenRequestIds = ids;

  if (fresh.length && document.hidden && window.Notification?.permission === 'granted') {
    new Notification(`${fresh.length} permission request${fresh.length > 1 ? 's' : ''}`, {
      body: 'Claude Code is waiting for approval.',
      tag: 'compa-pending',
    });
  }
}

function connect() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    el.conn.dataset.state = 'live';
    el.conn.textContent = 'live';
  });

  source.addEventListener('message', (event) => {
    const next = JSON.parse(event.data);
    notifyNew(next);
    state = next;
    render();
  });

  source.addEventListener('error', () => {
    el.conn.dataset.state = 'lost';
    el.conn.textContent = 'reconnecting';
    source.close();
    setTimeout(connect, 1500);
  });
}

if (window.Notification && Notification.permission === 'default') {
  // Asked on the first click rather than on load, so the browser honours it.
  document.addEventListener('click', () => Notification.requestPermission(), { once: true });
}

render();
connect();
