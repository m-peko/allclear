#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { SETTINGS_FILE, DEFAULT_PORT } = require('../src/paths');
const { createServer } = require('../src/server');

const ALLCLEAR_HOOK_URL = /^https?:\/\/127\.0\.0\.1:\d+\/hook\//;

const args = process.argv.slice(2);

// Flags that consume the token after them, so `allclear --port 4596` doesn't mistake
// 4596 for the command name.
const VALUE_FLAGS = new Set(['--port']);

function parseCommand(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('-')) {
      if (VALUE_FLAGS.has(argv[i])) i += 1;
      continue;
    }
    return argv[i];
  }
  return 'setup';
}

const command = parseCommand(args);

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
    // response decides the outcome. 600s is the window allclear has to get an
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
    const backup = `${SETTINGS_FILE}.allclear-backup-${Date.now()}`;
    fs.copyFileSync(SETTINGS_FILE, backup);
    console.log(`  backed up existing settings to ${backup}`);
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

function isAllclearGroup(group) {
  return (
    group &&
    Array.isArray(group.hooks) &&
    group.hooks.length > 0 &&
    group.hooks.every((hook) => hook.type === 'http' && ALLCLEAR_HOOK_URL.test(hook.url || ''))
  );
}

// Removes allclear's own groups while leaving every other hook untouched.
function stripAllclear(hooks) {
  const cleaned = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) {
      cleaned[event] = groups;
      continue;
    }
    const kept = groups.filter((group) => !isAllclearGroup(group));
    if (kept.length) cleaned[event] = kept;
  }
  return cleaned;
}

function install() {
  const settings = readSettings();
  const hooks = stripAllclear(settings.hooks);

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
  console.log(`✓ allclear hooks installed into ${SETTINGS_FILE}`);
  console.log('  PermissionRequest → approve or deny from the dashboard');
  console.log('  Notification, SessionEnd → status only');
  console.log('\nRunning sessions pick these up within seconds. Next: allclear start');
}

function uninstall() {
  const settings = readSettings();
  const before = JSON.stringify(settings.hooks || {});
  settings.hooks = stripAllclear(settings.hooks);
  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  if (JSON.stringify(settings.hooks || {}) === before) {
    console.log('No allclear hooks found — nothing to remove.');
    return;
  }
  writeSettings(settings);
  console.log(`✓ allclear hooks removed from ${SETTINGS_FILE}`);
}

function installedGroups(settings) {
  return Object.values(settings.hooks || {})
    .flatMap((g) => (Array.isArray(g) ? g : []))
    .filter(isAllclearGroup);
}

// The port baked into the installed hooks. A server listening anywhere else
// receives nothing at all, and does so silently, so it is worth saying.
function installedPort(settings) {
  for (const group of installedGroups(settings)) {
    for (const hook of group.hooks) {
      const match = /^https?:\/\/127\.0\.0\.1:(\d+)\//.exec(hook.url || '');
      if (match) return Number(match[1]);
    }
  }
  return null;
}

// The one-command path: make sure the hooks are in place, then run. This is what
// a bare `allclear` does, so a first run is a single command.
function setup() {
  if (installedGroups(readSettings()).length) {
    console.log(`✓ allclear hooks already in ${SETTINGS_FILE}`);
  } else {
    console.log(`Adding allclear's hooks to ${SETTINGS_FILE} …`);
    install();
  }
  console.log('');
  start();
}

function status() {
  const settings = readSettings();
  const installed = installedGroups(settings);

  console.log(`settings:  ${SETTINGS_FILE}`);
  console.log(`hooks:     ${installed.length ? `installed (${installed.length} groups)` : 'not installed — run: allclear install'}`);

  const sessions = require('../src/sessions').readAll();
  console.log(`sessions:  ${sessions.length} live`);
  for (const session of sessions) {
    console.log(`           ${session.status.padEnd(8)} ${session.name.padEnd(18)} ${session.cwd}`);
  }

  fetch(`http://127.0.0.1:${port}/api/state`)
    .then((res) => res.json())
    .then((state) => console.log(`server:    running on ${port} (${state.pendingCount} waiting)`))
    .catch(() => console.log(`server:    not running on ${port} — run: allclear start`));
}

const TOKEN_FILE = path.join(path.dirname(SETTINGS_FILE), 'allclear-token');

// Kept on disk so the phone's bookmark survives a restart.
function readOrCreateToken() {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const token = require('crypto').randomBytes(16).toString('base64url');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}

function lanAddresses() {
  const found = [];
  for (const entries of Object.values(require('os').networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

// A phone can't be asked to type a token by hand. Use qrencode when it's there.
function showQr(url) {
  try {
    const { status } = require('child_process').spawnSync('qrencode', ['--version'], {
      stdio: 'ignore',
    });
    if (status !== 0) return false;
    const out = require('child_process').spawnSync('qrencode', ['-t', 'ANSIUTF8', '-m', '1', url], {
      encoding: 'utf8',
    });
    if (out.status !== 0 || !out.stdout) return false;
    process.stdout.write(`\n${out.stdout}`);
    return true;
  } catch {
    return false;
  }
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
  // Loopback by default. --lan opens it to the network, which always carries a
  // token: approving a tool call runs a command on this machine, so being able
  // to reach the port must not be enough to do it.
  const lan = flag('lan');
  const token = lan ? readOrCreateToken() : null;
  const host = lan ? '0.0.0.0' : '127.0.0.1';

  const server = createServer({ token });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Another allclear may be running, or pass --port.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, host, () => {
    const url = `http://127.0.0.1:${port}${token ? `/?t=${token}` : ''}`;
    const settings = readSettings();
    const installed = installedGroups(settings).length > 0;
    const hookPort = installedPort(settings);

    console.log(`allclear → ${url}`);

    if (lan) {
      const addresses = lanAddresses();
      if (!addresses.length) {
        console.log('  (no network address found — is this machine on a network?)');
      }
      for (const address of addresses) {
        console.log(`          → http://${address}:${port}/?t=${token}`);
      }
      console.log('');
      console.log('  Open that on your phone — it must be on the same network.');
      console.log('  Anyone with this link can approve tool calls on this machine.');
      console.log(`  The token lives in ${TOKEN_FILE}; delete it to issue a new one.`);
      if (addresses.length && !flag('no-qr')) showQr(`http://${addresses[0]}:${port}/?t=${token}`);
    }

    if (!installed) {
      console.log('⚠ hooks are not installed yet — run: allclear install');
    } else if (hookPort && hookPort !== port) {
      console.log(`⚠ your hooks point at port ${hookPort}, so nothing will reach this server.`);
      console.log(`  Run: allclear install --port ${port}`);
    }
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

const commands = { setup, start, install, uninstall, status };

if (!commands[command] || flag('help')) {
  console.log(`allclear — approve Claude Code permission requests from your browser

  allclear              set up if needed, then open the dashboard
  allclear start        run the dashboard without touching your settings
  allclear install      add allclear's hooks to ~/.claude/settings.json (backs it up first)
  allclear status       show hooks, live sessions and whether the server is up
  allclear uninstall    remove allclear's hooks

  --lan              also serve on your local network, for a phone or tablet.
                     Prints a link carrying an access token, and a QR code if
                     qrencode is installed
  --port N           use a different port (default ${DEFAULT_PORT})
  --no-open          don't open a browser

Not installed? Run it straight from GitHub:
  npx github:m-peko/allclear
`);
  process.exit(!commands[command] && command !== 'help' ? 1 : 0);
}

commands[command]();
