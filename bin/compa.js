#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { SETTINGS_FILE, DEFAULT_PORT } = require('../src/paths');
const { createServer } = require('../src/server');

const COMPA_HOOK_URL = /^https?:\/\/127\.0\.0\.1:\d+\/hook\//;

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('-')) || 'start';

function flag(name) {
  return args.includes(`--${name}`);
}

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
}

const port = Number(option('port', DEFAULT_PORT));

// --------------------------------------------------------------- hook config

function hookConfig(forPort) {
  const base = `http://127.0.0.1:${forPort}/hook`;
  return {
    // Fires only when Claude Code is about to ask for permission, and its
    // response decides the outcome. 600s is the window compa has to get an
    // answer out of the browser; the server releases at 540s.
    PermissionRequest: [
      { hooks: [{ type: 'http', url: `${base}/permission-request`, timeout: 600 }] },
    ],
    // Backstop: a handful of prompts (a sandboxed command's network request)
    // never raise PermissionRequest. This at least makes them visible.
    Notification: [
      {
        matcher: 'permission_prompt',
        hooks: [{ type: 'http', url: `${base}/notification`, timeout: 10 }],
      },
    ],
    // SessionEnd hooks share a tight budget, so keep this one short.
    SessionEnd: [{ hooks: [{ type: 'http', url: `${base}/session-end`, timeout: 2 }] }],
  };
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not parse ${SETTINGS_FILE}: ${err.message}`);
  }
}

function writeSettings(settings) {
  if (fs.existsSync(SETTINGS_FILE)) {
    const backup = `${SETTINGS_FILE}.compa-backup-${Date.now()}`;
    fs.copyFileSync(SETTINGS_FILE, backup);
    console.log(`  backed up existing settings to ${backup}`);
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

function isCompaGroup(group) {
  return (
    group &&
    Array.isArray(group.hooks) &&
    group.hooks.length > 0 &&
    group.hooks.every((hook) => hook.type === 'http' && COMPA_HOOK_URL.test(hook.url || ''))
  );
}

// Removes compa's own groups while leaving every other hook untouched.
function stripCompa(hooks) {
  const cleaned = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) {
      cleaned[event] = groups;
      continue;
    }
    const kept = groups.filter((group) => !isCompaGroup(group));
    if (kept.length) cleaned[event] = kept;
  }
  return cleaned;
}

function install() {
  const settings = readSettings();
  const hooks = stripCompa(settings.hooks);

  for (const [event, groups] of Object.entries(hookConfig(port))) {
    hooks[event] = [...(hooks[event] || []), ...groups];
  }
  settings.hooks = hooks;

  if (Array.isArray(settings.allowedHttpHookUrls)) {
    console.log(
      '  note: allowedHttpHookUrls is set in your settings — make sure it covers ' +
        `http://127.0.0.1:${port}/hook/*`
    );
  }

  writeSettings(settings);
  console.log(`✓ compa hooks installed into ${SETTINGS_FILE}`);
  console.log('  PermissionRequest → approve or deny from the dashboard');
  console.log('  Notification, SessionEnd → status only');
  console.log('\nRestart any running Claude Code sessions to pick the hooks up, then: compa start');
}

function uninstall() {
  const settings = readSettings();
  const before = JSON.stringify(settings.hooks || {});
  settings.hooks = stripCompa(settings.hooks);
  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  if (JSON.stringify(settings.hooks || {}) === before) {
    console.log('No compa hooks found — nothing to remove.');
    return;
  }
  writeSettings(settings);
  console.log(`✓ compa hooks removed from ${SETTINGS_FILE}`);
}

function status() {
  const settings = readSettings();
  const groups = Object.values(settings.hooks || {}).flatMap((g) => (Array.isArray(g) ? g : []));
  const installed = groups.filter(isCompaGroup);

  console.log(`settings:  ${SETTINGS_FILE}`);
  console.log(`hooks:     ${installed.length ? `installed (${installed.length} groups)` : 'not installed — run: compa install'}`);

  const sessions = require('../src/sessions').readAll();
  console.log(`sessions:  ${sessions.length} live`);
  for (const session of sessions) {
    console.log(`           ${session.status.padEnd(8)} ${session.name.padEnd(18)} ${session.cwd}`);
  }

  fetch(`http://127.0.0.1:${port}/api/state`)
    .then((res) => res.json())
    .then((state) => console.log(`server:    running on ${port} (${state.pendingCount} waiting)`))
    .catch(() => console.log(`server:    not running on ${port} — run: compa start`));
}

function openBrowser(url) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* headless box: the printed URL is enough */
  }
}

function start() {
  const server = createServer();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Another compa may be running, or pass --port.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    const settings = readSettings();
    const installed = Object.values(settings.hooks || {})
      .flatMap((g) => (Array.isArray(g) ? g : []))
      .some(isCompaGroup);

    console.log(`compa → ${url}`);
    if (!installed) console.log('⚠ hooks are not installed yet — run: compa install');
    if (!flag('no-open')) openBrowser(url);
  });

  const shutdown = () => {
    console.log('\nstopping — any held requests fall back to the terminal prompt');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const commands = { start, install, uninstall, status };

if (!commands[command]) {
  console.log(`compa — approve Claude Code permission requests from your browser

  compa install      add compa's hooks to ~/.claude/settings.json (backs it up first)
  compa start        run the dashboard        [--port N] [--no-open]
  compa status       show hooks, sessions, server
  compa uninstall    remove compa's hooks
`);
  process.exit(command === 'help' || flag('help') ? 0 : 1);
}

commands[command]();
