'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { PUBLIC_DIR, DEFAULT_PORT } = require('./paths');
const sessionStore = require('./sessions');
const transcript = require('./transcript');

// Claude Code cancels an HTTP hook once its `timeout` elapses (we install the
// hook with 600s). Release a little before that so the fallback is ours and
// predictable: we answer with an empty body, which Claude Code reads as "no
// decision" and falls through to the normal terminal prompt.
const HOLD_MS = Number(process.env.COMPA_HOLD_MS || 540_000);
const SCAN_INTERVAL_MS = 1000;
const MAX_ACTIVITY = 60;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function createServer() {
  /** @type {Map<string, any>} id -> held permission request */
  const pending = new Map();
  /** @type {Map<string, any>} sessionId -> session record from ~/.claude/sessions */
  let liveSessions = new Map();
  /** @type {Set<http.ServerResponse>} */
  const sseClients = new Set();
  const activity = [];
  const notices = new Map(); // sessionId -> prompt Claude Code reported as stuck waiting

  let autoApprove = false;
  let broadcastTimer = null;

  // ---------------------------------------------------------------- utilities

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        raw += chunk;
        if (raw.length > 4_000_000) {
          aborted = true;
          reject(new Error('request body too large'));
        }
      });
      req.on('end', () => {
        if (aborted) return;
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  function logActivity(entry) {
    activity.unshift({ ...entry, at: Date.now() });
    if (activity.length > MAX_ACTIVITY) activity.length = MAX_ACTIVITY;
  }

  // ------------------------------------------------------------------- state

  function publicRequest(req) {
    return {
      id: req.id,
      sessionId: req.sessionId,
      toolName: req.toolName,
      toolInput: req.toolInput,
      cwd: req.cwd,
      permissionMode: req.permissionMode,
      createdAt: req.createdAt,
      expiresAt: req.createdAt + HOLD_MS,
      canRemember: Boolean(req.rememberSuggestion),
      rememberLabel: req.rememberLabel,
    };
  }

  function snapshot() {
    const bySession = new Map();
    for (const req of pending.values()) {
      if (!bySession.has(req.sessionId)) bySession.set(req.sessionId, []);
      bySession.get(req.sessionId).push(publicRequest(req));
    }

    const sessions = [];
    for (const session of liveSessions.values()) {
      const requests = (bySession.get(session.sessionId) || []).sort(
        (a, b) => a.createdAt - b.createdAt
      );
      const notice = notices.get(session.sessionId) || null;
      // Expanded cards show the conversation; collapsed ones don't need it, and
      // skipping them keeps the broadcast small.
      const active = Boolean(
        requests.length || notice || session.status === 'busy' || session.status === 'waiting'
      );
      sessions.push({
        ...session,
        notice,
        active,
        pending: requests,
        messages: active ? transcript.read(session.sessionId, 10) : null,
      });
    }

    // A request can arrive from a session that has no file in ~/.claude/sessions
    // (headless runs, cloud sessions). Surface it anyway, built from the hook
    // payload, so nothing waiting for a human is invisible.
    for (const [sessionId, requests] of bySession) {
      if (liveSessions.has(sessionId)) continue;
      sessions.push({
        sessionId,
        pid: null,
        name: sessionId.slice(0, 8),
        cwd: requests[0].cwd || '',
        status: 'waiting',
        kind: 'detached',
        entrypoint: '',
        version: '',
        startedAt: null,
        updatedAt: requests[0].createdAt,
        detached: true,
        notice: null,
        active: true,
        pending: requests,
        messages: transcript.read(sessionId, 10),
      });
    }

    const rank = (s) => (s.pending.length ? 0 : s.notice ? 1 : s.status === 'busy' ? 2 : 3);
    sessions.sort((a, b) => rank(a) - rank(b) || (b.updatedAt || 0) - (a.updatedAt || 0));

    return {
      sessions,
      pendingCount: pending.size,
      autoApprove,
      activity,
      holdMs: HOLD_MS,
      now: Date.now(),
    };
  }

  function broadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (!sseClients.size) return;
      const frame = `data: ${JSON.stringify(snapshot())}\n\n`;
      for (const client of sseClients) client.write(frame);
    }, 60);
  }

  function scanSessions() {
    const next = new Map();
    for (const session of sessionStore.readAll()) next.set(session.sessionId, session);

    let changed = next.size !== liveSessions.size;
    if (!changed) {
      for (const [id, session] of next) {
        const prev = liveSessions.get(id);
        if (!prev || prev.status !== session.status || prev.updatedAt !== session.updatedAt) {
          changed = true;
          break;
        }
      }
    }

    // Drop notices belonging to sessions that have gone away.
    for (const sessionId of notices.keys()) {
      if (!next.has(sessionId)) {
        notices.delete(sessionId);
        changed = true;
      }
    }

    liveSessions = next;
    if (changed) broadcast();
  }

  // -------------------------------------------------------------- decisions

  function respondAllow(req, remember) {
    const decision = { behavior: 'allow' };
    if (remember && req.rememberSuggestion) decision.updatedPermissions = [req.rememberSuggestion];
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }

  function respondDeny(message) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: message || 'Denied from the compa dashboard.' },
      },
    };
  }

  function resolveRequest(id, behavior, options = {}) {
    const req = pending.get(id);
    if (!req) return false;

    pending.delete(id);
    clearTimeout(req.timer);

    const body =
      behavior === 'allow' ? respondAllow(req, options.remember) : respondDeny(options.message);
    sendJson(req.res, 200, body);

    logActivity({
      sessionId: req.sessionId,
      sessionName: req.sessionName,
      toolName: req.toolName,
      toolInput: req.toolInput,
      behavior,
      remembered: Boolean(options.remember && req.rememberSuggestion),
      via: options.via || 'dashboard',
    });
    return true;
  }

  // Release the hook without a decision: Claude Code continues its normal
  // permission flow and prompts in the terminal as it always would.
  function releaseRequest(id, reason) {
    const req = pending.get(id);
    if (!req) return false;
    pending.delete(id);
    clearTimeout(req.timer);
    res204(req.res);
    logActivity({
      sessionId: req.sessionId,
      sessionName: req.sessionName,
      toolName: req.toolName,
      toolInput: req.toolInput,
      behavior: 'released',
      via: reason,
    });
    return true;
  }

  function res204(res) {
    // "2xx with an empty body" is how Claude Code spells "no decision".
    res.writeHead(200, { 'content-length': 0, 'cache-control': 'no-store' });
    res.end();
  }

  // --------------------------------------------------------------- hook entry

  // Pick the suggestion that turns this one-off approval into a standing rule,
  // so the dashboard can offer "always allow" the way the terminal prompt does.
  function pickRememberSuggestion(suggestions) {
    if (!Array.isArray(suggestions)) return null;
    for (const suggestion of suggestions) {
      if (suggestion && suggestion.type === 'addRules' && suggestion.behavior === 'allow') {
        const rules = Array.isArray(suggestion.rules) ? suggestion.rules : [];
        const label = rules
          .map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName))
          .join(', ');
        return {
          suggestion: { ...suggestion, destination: suggestion.destination || 'localSettings' },
          label,
        };
      }
    }
    return null;
  }

  async function handlePermissionRequest(req, res) {
    let payload;
    try {
      payload = await readBody(req);
    } catch {
      return res204(res); // malformed: let the terminal prompt handle it
    }

    const sessionId = payload.session_id || 'unknown';
    const session = liveSessions.get(sessionId);
    const remember = pickRememberSuggestion(payload.permission_suggestions);

    const record = {
      id: crypto.randomUUID(),
      sessionId,
      sessionName: session ? session.name : sessionId.slice(0, 8),
      cwd: payload.cwd || (session ? session.cwd : ''),
      toolName: payload.tool_name || 'unknown',
      toolInput: payload.tool_input || {},
      permissionMode: payload.permission_mode || 'default',
      rememberSuggestion: remember ? remember.suggestion : null,
      rememberLabel: remember ? remember.label : null,
      createdAt: Date.now(),
      res,
      timer: null,
    };

    if (autoApprove) {
      sendJson(res, 200, respondAllow(record, false));
      logActivity({
        sessionId,
        sessionName: record.sessionName,
        toolName: record.toolName,
        toolInput: record.toolInput,
        behavior: 'allow',
        via: 'auto-approve',
      });
      broadcast();
      return;
    }

    // If the hook's socket dies (session killed, Claude Code cancelled the
    // hook), stop holding the slot.
    res.on('close', () => {
      if (pending.has(record.id)) {
        pending.delete(record.id);
        clearTimeout(record.timer);
        broadcast();
      }
    });

    record.timer = setTimeout(() => releaseRequest(record.id, 'timeout'), HOLD_MS);
    pending.set(record.id, record);
    notices.delete(sessionId); // the live request supersedes any stale notice
    broadcast();
  }

  // Claude Code raises this ~6s after a prompt has gone unanswered. It covers
  // the few prompts PermissionRequest never sees (a sandboxed command's network
  // request, for one), so the dashboard shows them even though it cannot answer
  // them from here.
  async function handleNotification(req, res) {
    let payload;
    try {
      payload = await readBody(req);
    } catch {
      return res204(res);
    }
    const sessionId = payload.session_id;
    const type = payload.notification_type || payload.type || '';
    if (sessionId && String(type).includes('permission')) {
      const hasLiveRequest = [...pending.values()].some((r) => r.sessionId === sessionId);
      if (!hasLiveRequest) {
        notices.set(sessionId, {
          message: payload.message || 'Waiting for permission in the terminal.',
          at: Date.now(),
        });
        broadcast();
      }
    }
    res204(res);
  }

  function handleSessionEnd(req, res) {
    readBody(req)
      .then((payload) => {
        const sessionId = payload.session_id;
        if (sessionId) {
          notices.delete(sessionId);
          for (const [id, record] of pending) {
            if (record.sessionId === sessionId) releaseRequest(id, 'session-ended');
          }
          broadcast();
        }
      })
      .catch(() => {})
      .finally(() => res204(res));
  }

  // ------------------------------------------------------------------ static

  function serveStatic(req, res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  }

  // ------------------------------------------------------------------ router

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    try {
      switch (route) {
        case 'POST /hook/permission-request':
          return await handlePermissionRequest(req, res);
        case 'POST /hook/notification':
          return await handleNotification(req, res);
        case 'POST /hook/session-end':
          return handleSessionEnd(req, res);

        case 'GET /api/state':
          return sendJson(res, 200, snapshot());

        // Used when someone expands a collapsed card by hand: that session's
        // conversation isn't carried in the broadcast.
        case 'GET /api/transcript': {
          const sessionId = url.searchParams.get('sessionId') || '';
          if (!/^[\w-]{1,128}$/.test(sessionId)) return sendJson(res, 400, { ok: false });
          return sendJson(res, 200, { sessionId, messages: transcript.read(sessionId, 10) });
        }

        case 'GET /api/stream': {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
          sseClients.add(res);
          const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
          req.on('close', () => {
            clearInterval(keepAlive);
            sseClients.delete(res);
          });
          return;
        }

        case 'POST /api/decide': {
          const body = await readBody(req);
          const ok = resolveRequest(body.id, body.behavior === 'deny' ? 'deny' : 'allow', {
            remember: Boolean(body.remember),
            message: body.message,
          });
          broadcast();
          return sendJson(res, ok ? 200 : 410, { ok });
        }

        case 'POST /api/approve-all': {
          const body = await readBody(req);
          const ids = [...pending.keys()].filter((id) => {
            if (!body.sessionId) return true;
            const record = pending.get(id);
            return record && record.sessionId === body.sessionId;
          });
          let approved = 0;
          for (const id of ids) {
            if (resolveRequest(id, 'allow', { via: body.sessionId ? 'approve-session' : 'approve-all' })) {
              approved += 1;
            }
          }
          broadcast();
          return sendJson(res, 200, { ok: true, approved });
        }

        case 'POST /api/auto-approve': {
          const body = await readBody(req);
          autoApprove = Boolean(body.enabled);
          if (autoApprove) {
            for (const id of [...pending.keys()]) resolveRequest(id, 'allow', { via: 'auto-approve' });
          }
          broadcast();
          return sendJson(res, 200, { ok: true, autoApprove });
        }

        default:
          if (req.method === 'GET') return serveStatic(req, res, url.pathname);
          res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      }
    } catch (err) {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: String(err && err.message) });
      else res.end();
    }
  });

  // Holding a hook open for minutes is the whole point, so no socket timeout.
  server.timeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 72_000;

  const scanTimer = setInterval(scanSessions, SCAN_INTERVAL_MS);
  scanTimer.unref();
  scanSessions();

  const originalClose = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(scanTimer);
    for (const id of [...pending.keys()]) releaseRequest(id, 'server-stopped');
    for (const client of sseClients) client.end();
    return originalClose(cb);
  };

  return server;
}

module.exports = { createServer, DEFAULT_PORT };
