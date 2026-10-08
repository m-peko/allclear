'use strict';

// Everything rendered here comes from tool inputs and transcripts of live Claude
// Code sessions. It is built with createElement/textContent only — never
// innerHTML — so content from a tool argument can't execute in the dashboard.

const el = {
  sessions: document.getElementById('sessions'),
  statSessions: document.getElementById('stat-sessions'),
  statActive: document.getElementById('stat-active'),
  statPending: document.getElementById('stat-pending'),
  approveAll: document.getElementById('approve-all'),
  autoApprove: document.getElementById('auto-approve'),
  theme: document.getElementById('theme'),
  conn: document.getElementById('conn'),
  activity: document.getElementById('activity'),
  activityEmpty: document.getElementById('activity-empty'),
  idleList: document.getElementById('idle-list'),
  idleEmpty: document.getElementById('idle-empty'),
  idleCount: document.getElementById('idle-count'),
};

let state = { sessions: [], pendingCount: 0, autoApprove: false, activity: [] };
let seenRequestIds = new Set();
const busyIds = new Set();

// A card has three states, and they are independent: whether it is on the grid
// at all, and if so whether its body is open. Collapsing is not the same gesture
// as putting it away.
const pinned = new Set(); // opened from the sidebar: stays on the grid
const dismissed = new Set(); // sent away with the × : stays off the grid
const collapsed = new Set(); // on the grid, body folded shut
// Transcripts for sessions the server doesn't ship chat for (collapsed ones the
// user expanded by hand).
const fetchedChats = new Map();
// Remembered scroll position per chat pane, so re-renders don't jump.
const chatScroll = new Map();

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// ------------------------------------------------------------------- theme

const THEME_KEY = 'compa.theme';

function readStore(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or blocked storage: sizing just won't persist */
  }
}

function activeTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === 'dark' || set === 'light') return set;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

el.theme.addEventListener('click', () => {
  const next = activeTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
});

// -------------------------------------------------------------- card sizing

// { default: {span, chatH}, bySession: { [id]: {span, chatH} } }
// A resize updates both that card and the default, so the next session to appear
// inherits the size you last chose rather than reverting.
const SIZE_KEY = 'compa.cardSizes';
const sizes = Object.assign({ default: null, bySession: {} }, readStore(SIZE_KEY, {}));

function sizeFor(sessionId) {
  return sizes.bySession[sessionId] || sizes.default || null;
}

function rememberSize(sessionId, size) {
  sizes.bySession[sessionId] = size;
  sizes.default = size;

  const keys = Object.keys(sizes.bySession);
  if (keys.length > 200) delete sizes.bySession[keys[0]];
  writeStore(SIZE_KEY, sizes);
}

function forgetSize(sessionId) {
  delete sizes.bySession[sessionId];
  writeStore(SIZE_KEY, sizes);
}

// Columns are equal in an auto-fill grid, so one stride covers them all.
function gridMetrics() {
  const style = getComputedStyle(el.sessions);
  const columns = style.gridTemplateColumns.split(' ').filter(Boolean).map(parseFloat);
  const gap = parseFloat(style.columnGap) || 0;
  return { count: Math.max(1, columns.length), stride: (columns[0] || 300) + gap, gap };
}

let resizing = null;
let renderQueued = false;

const snappedWidth = (span, stride, gap) => span * stride - gap;

function beginResize(event, card, session) {
  event.preventDefault();
  event.stopPropagation(); // the header's click handler must not toggle the card

  const chat = card.querySelector('.chat');
  const { count, stride, gap } = gridMetrics();

  const ghost = node('div', 'resize-ghost');
  document.body.append(ghost);

  resizing = {
    sessionId: session.sessionId,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: card.offsetWidth,
    startChatH: chat ? chat.offsetHeight : 0,
    result: { ...(sizeFor(session.sessionId) || {}) },
    card,
    chat,
    ghost,
    count,
    stride,
    gap,
    span: null,
  };

  card.classList.add('resizing');
  document.body.classList.add('resizing');
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', endResize, { once: true });
  window.addEventListener('pointercancel', endResize, { once: true });

  onResizeMove(event);
}

function onResizeMove(event) {
  if (!resizing) return;
  const { card, chat, ghost, stride, gap, count } = resizing;

  // The card itself takes the raw pointer width, overflowing its track. Nothing
  // else in the grid moves, so the drag stays smooth.
  const raw = clamp(
    resizing.startWidth + (event.clientX - resizing.startX),
    snappedWidth(1, stride, gap),
    snappedWidth(count, stride, gap)
  );
  card.style.width = `${raw}px`;

  if (chat) {
    const height = clamp(resizing.startChatH + (event.clientY - resizing.startY), 110, 1200);
    chat.style.height = `${height}px`;
    resizing.result.chatH = height;
  }

  // A card spanning n columns is n*stride - gap wide, so invert that for n.
  const span = clamp(Math.round((raw + gap) / stride), 1, count);
  resizing.span = span;
  resizing.result.span = span;

  // The card's left/top never change during a resize, but the page may scroll,
  // so read them fresh rather than caching the opening rect.
  const rect = card.getBoundingClientRect();
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${snappedWidth(span, stride, gap)}px`;
  ghost.style.height = `${rect.height}px`;
}

function endResize() {
  if (!resizing) return;
  const { card, chat, ghost, sessionId, result, span, stride, gap } = resizing;

  ghost.remove();
  card.classList.remove('resizing');
  document.body.classList.remove('resizing');
  window.removeEventListener('pointermove', onResizeMove);
  rememberSize(sessionId, result);
  resizing = null;

  // Animate the last few pixels onto the column boundary, then hand the width
  // back to the grid. Swapping to the span at the same width is seamless.
  const target = snappedWidth(span || 1, stride, gap);
  const settle = () => {
    card.classList.remove('settling');
    card.style.transition = '';
    card.style.width = '';
    card.style.gridColumn = `span ${span || 1}`;
    if (renderQueued) {
      renderQueued = false;
      render();
    }
  };

  if (Math.abs(card.offsetWidth - target) < 1) {
    settle();
    return;
  }

  card.classList.add('settling');
  card.style.width = `${target}px`;
  // transitionend alone can be missed if the layout settles early.
  const done = () => {
    card.removeEventListener('transitionend', done);
    clearTimeout(timer);
    settle();
  };
  const timer = setTimeout(done, 260);
  card.addEventListener('transitionend', done);

  // Chat height is free-form, so it is already where it should be.
  void chat;
}

// ------------------------------------------------------------------ helpers

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Stroked icons on a fixed 16-unit grid. Glyphs like › and × sit on a text
// baseline and refuse to centre against each other; two identical boxes do.
function icon(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }
  return svg;
}

const CHEVRON = ['M6 3.5 L10.5 8 L6 12.5'];
const CROSS = ['M4.2 4.2 L11.8 11.8', 'M11.8 4.2 L4.2 11.8'];

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
  return {
    text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`,
    urgent: left < 60,
  };
}

// Sessions flip between busy and idle constantly while they work. Expanding and
// collapsing on every flip would make the grid twitch, so a card that was active
// stays open for a while after it settles.
const STICKY_MS = 30_000;
const activeSince = new Map();

function noteActivity() {
  const now = Date.now();
  for (const session of state.sessions) {
    if (session.active) activeSince.set(session.sessionId, now);
  }
}

function onGrid(session) {
  // A request waiting on you is never tucked away in the sidebar, whatever was
  // put away earlier.
  if (session.pending.length) return true;
  if (pinned.has(session.sessionId)) return true;
  if (dismissed.has(session.sessionId)) return false;
  if (session.active) return true;
  const last = activeSince.get(session.sessionId);
  return Boolean(last && Date.now() - last < STICKY_MS);
}

function isExpanded(session) {
  return onGrid(session) && !collapsed.has(session.sessionId);
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
  render();
  post('/api/decide', { id, behavior, remember }).finally(() => busyIds.delete(id));
}

function approveAll(sessionId) {
  const ids = state.sessions.flatMap((s) =>
    !sessionId || s.sessionId === sessionId ? s.pending.map((p) => p.id) : []
  );
  ids.forEach((id) => busyIds.add(id));
  render();
  post('/api/approve-all', sessionId ? { sessionId } : {}).finally(() =>
    ids.forEach((id) => busyIds.delete(id))
  );
}

async function loadChat(sessionId) {
  try {
    const res = await fetch(`/api/transcript?sessionId=${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    fetchedChats.set(sessionId, data.messages || []);
    render();
  } catch {
    /* the pane just stays empty */
  }
}

// Clicking the header folds the card where it sits; it does not put it away.
function toggleCollapse(session) {
  const id = session.sessionId;
  if (collapsed.has(id)) {
    collapsed.delete(id);
    if (!session.messages) loadChat(id);
  } else {
    collapsed.add(id);
  }
  render();
}

// The × takes the card off the grid and leaves it in the sidebar.
function dismiss(session) {
  dismissed.add(session.sessionId);
  pinned.delete(session.sessionId);
  collapsed.delete(session.sessionId);
  render();
}

function openFromSidebar(session) {
  pinned.add(session.sessionId);
  dismissed.delete(session.sessionId);
  collapsed.delete(session.sessionId);
  if (!session.messages) loadChat(session.sessionId);
  render();
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
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if ((event.key === 'a' || event.key === 'A') && state.pendingCount > 0) approveAll(null);
});

// ------------------------------------------------------------------ rendering

function renderChat(session) {
  const messages = session.messages || fetchedChats.get(session.sessionId) || [];
  const chat = node('div', 'chat');
  chat.dataset.session = session.sessionId;

  const size = sizeFor(session.sessionId);
  if (size && size.chatH) chat.style.height = `${size.chatH}px`;

  if (!messages.length) {
    chat.append(node('div', 'chat-empty', 'No conversation yet.'));
    return chat;
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      const row = node('div', 'msg msg-tool');
      row.append(node('span', 'tname', message.tool));
      const arg = node('span', 'targ', String(message.text || '').replace(/\s+/g, ' '));
      arg.title = message.text || '';
      row.append(arg);
      chat.append(row);
      continue;
    }

    const wrap = node('div', `msg msg-${message.role}`);
    wrap.append(node('div', 'who', message.role === 'user' ? 'you' : 'claude'));
    wrap.append(node('div', null, message.text));
    chat.append(wrap);
  }

  return chat;
}

function renderRequest(request) {
  const wrap = node('div', 'req');
  const { summary, lines } = describeTool(request.toolName, request.toolInput);

  const head = node('div', 'req-head');
  head.append(node('span', 'tool', request.toolName));
  head.append(node('span', 'req-desc', summary || ''));

  const timer = countdown(request.expiresAt);
  const clock = node('span', `countdown${timer.urgent ? ' urgent' : ''}`, timer.text);
  clock.title =
    'Time left before compa stops holding this request and Claude Code falls back to the terminal prompt.';
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

function repoLabel(session) {
  if (!session.repo) return '';
  return session.worktree ? `${session.repo}/${session.worktree}` : session.repo;
}

function renderSession(session, columnCount) {
  const expanded = isExpanded(session);
  const classes = ['card'];
  classes.push(expanded ? 'expanded' : 'folded');
  if (session.pending.length) classes.push('pending');
  const card = node('div', classes.join(' '));

  // Folding changes a card's height, not its place in the row, so the
  // remembered width applies whether it is open or shut.
  const size = sizeFor(session.sessionId);
  if (size && size.span) {
    card.style.gridColumn = `span ${clamp(size.span, 1, columnCount)}`;
  }

  const head = node('div', 'card-head');
  head.addEventListener('click', (event) => {
    if (event.target.closest('button')) return; // header buttons act on their own
    toggleCollapse(session);
  });

  const chev = node('span', 'chev');
  chev.append(icon(CHEVRON));
  chev.title = expanded ? 'Fold this card' : 'Open this card';
  head.append(chev);

  const status = session.pending.length ? 'waiting' : session.status;
  const dot = node('span', `dot ${status}`);
  dot.title = status;
  head.append(dot);

  const repo = repoLabel(session);
  if (repo) {
    const tag = node('span', 'repo', repo);
    tag.title = session.cwd;
    head.append(tag);
  }

  const name = node('span', 'card-name', session.title || session.name);
  name.title = `${session.title || session.name}\n${session.cwd}`;
  head.append(name);

  if (session.pending.length) {
    head.append(node('span', 'badge hot', String(session.pending.length)));
    const approve = node('button', 'btn btn-sm btn-allow', 'Approve');
    approve.title = 'Approve every request from this session';
    approve.addEventListener('click', () => approveAll(session.sessionId));
    head.append(approve);
  } else {
    head.append(node('span', 'badge', session.status));
  }

  const close = node('button', 'close-btn');
  close.append(icon(CROSS));
  close.title = 'Remove from the grid (stays in the sidebar)';
  close.setAttribute('aria-label', 'Remove from grid');
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    dismiss(session);
  });
  head.append(close);

  card.append(head);

  if (expanded) {
    card.append(renderChat(session));
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
  }

  // Nothing to size on a folded card.
  if (expanded) {
    const handle = node('div', 'resize');
    handle.title = 'Drag to resize · double-click to reset';
    handle.addEventListener('pointerdown', (event) => beginResize(event, card, session));
    handle.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      forgetSize(session.sessionId);
      render();
    });
    card.append(handle);
  }

  return card;
}

function renderIdle(sessions) {
  el.idleList.replaceChildren();
  el.idleEmpty.hidden = sessions.length > 0;
  el.idleCount.textContent = sessions.length ? String(sessions.length) : '';

  for (const session of sessions) {
    const li = node('li', 'idle-item');
    li.title = `${session.title || session.name}\n${session.cwd}\n\nClick to put it on the grid`;
    li.addEventListener('click', () => openFromSidebar(session));

    li.append(node('span', `dot ${session.status}`));

    const text = node('span', 'idle-text');
    const repo = repoLabel(session);
    if (repo) text.append(node('span', 'idle-repo', repo));
    text.append(node('span', 'idle-name', session.title || session.name));
    li.append(text);

    el.idleList.append(li);
  }
}

function renderActivity() {
  el.activity.replaceChildren();
  el.activityEmpty.hidden = state.activity.length > 0;

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
          : entry.via === 'answered-in-terminal'
            ? 'answered'
            : 'released';

    li.append(node('span', `verb ${entry.behavior}`, verb));
    li.append(node('span', 'who', entry.sessionName || ''));

    const { summary } = describeTool(entry.toolName, entry.toolInput);
    const what = node('span', 'what', `${entry.toolName}${summary ? ` · ${summary}` : ''}`);
    what.title = summary || entry.toolName;
    li.append(what);

    li.append(node('span', 'when', relTime(entry.at)));
    el.activity.append(li);
  }
}

function render() {
  // Replacing the tree mid-drag would drop the element being resized.
  if (resizing) {
    renderQueued = true;
    return;
  }

  noteActivity();
  const pendingCount = state.pendingCount || 0;
  const activeCount = state.sessions.filter((s) => s.active).length;

  el.statSessions.textContent = String(state.sessions.length);
  el.statActive.textContent = String(activeCount);
  el.statPending.textContent = String(pendingCount);
  el.statPending.parentElement.classList.toggle('hot', pendingCount > 0);

  el.approveAll.disabled = pendingCount === 0;
  el.approveAll.replaceChildren(
    document.createTextNode(pendingCount ? `Approve all ${pendingCount}` : 'Approve all')
  );
  el.approveAll.append(node('kbd', null, 'A'));

  el.autoApprove.checked = Boolean(state.autoApprove);
  document.title = pendingCount ? `(${pendingCount}) compa` : 'compa';

  // Remember where each chat pane was scrolled before the tree is replaced.
  el.sessions.querySelectorAll('.chat[data-session]').forEach((pane) => {
    chatScroll.set(pane.dataset.session, {
      top: pane.scrollTop,
      atBottom: pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24,
    });
  });

  const { count } = gridMetrics();
  const open = state.sessions.filter(onGrid);
  const idle = state.sessions.filter((s) => !onGrid(s));

  el.sessions.replaceChildren();

  if (!state.sessions.length) {
    const empty = node('div', 'empty');
    empty.append(node('strong', null, 'No Claude Code sessions running'));
    empty.append(node('span', null, 'Start a session and it will appear here within a second.'));
    el.sessions.append(empty);
  } else if (!open.length) {
    const empty = node('div', 'empty');
    empty.append(node('strong', null, 'Everything is idle'));
    empty.append(node('span', null, 'Pick a session from the sidebar to open it.'));
    el.sessions.append(empty);
  } else {
    // Server order, as-is: within the grid nothing moves around as sessions
    // work, so a card never shifts out from under the pointer.
    open.forEach((session) => el.sessions.append(renderSession(session, count)));
  }

  renderIdle(idle);

  // Restore scroll: panes already at the bottom stay pinned to new output.
  el.sessions.querySelectorAll('.chat[data-session]').forEach((pane) => {
    const saved = chatScroll.get(pane.dataset.session);
    pane.scrollTop = !saved || saved.atBottom ? pane.scrollHeight : saved.top;
  });

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

// Refresh transcripts for collapsed sessions the user pinned open, and re-render
// so sticky expansion can lapse on a quiet dashboard that isn't being pushed to.
setInterval(() => {
  let fetching = false;
  for (const session of state.sessions) {
    if (isExpanded(session) && !session.messages) {
      loadChat(session.sessionId);
      fetching = true;
    }
  }
  if (!fetching) render();
}, 4000);

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
  document.addEventListener('click', () => Notification.requestPermission(), { once: true });
}

render();
connect();
