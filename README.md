# compa

A browser dashboard for every Claude Code session you have running. It shows which
sessions are alive, which ones are blocked on a permission request, and lets you
clear them all with one click.

If you keep eight terminals open and spend your day hunting for the one showing
`Do you want to proceed?`, this is for you.

```
┌──────────────┬────────────────────────────────────────────────┐
│ compa  live        8 sessions   3 active   2 waiting           │
│                    [Auto-approve]        [Approve all 2]       │
├──────────────┼────────────────────────────────────────────────┤
│ IDLE 5       │ ▾ api-server-8d   ~/work/api-server    1 [OK]  │
│ ● worker-12  │   claude  Reinstalling to clear the lockfile…  │
│ ● docs-4a    │   Bash    git status --porcelain               │
│ ● api-77     │   ┌ Bash  Reinstall dependencies         8:42 ┐│
│ ● web-3f     │   │ rm -rf node_modules && pnpm install       ││
│ ● jobs-91    │   └ [Approve] [Always allow]        [Deny] ───┘│
│              ├────────────────────────────────────────────────┤
│ RECENT       │ ▾ web-client-2c  ~/work/web-client      [BUSY] │
│ DECISIONS    │   you     ship the rename                      │
│ ALLOWED api  │   claude  Renaming the module and its imports… │
│ Bash · pnpm… │   Edit    src/session.ts                       │
│ DENIED  web  │                                                │
└──────────────┴────────────────────────────────────────────────┘
```

Active sessions fill the grid, expanded to show what they're doing — the recent
conversation, the tool calls, and anything waiting on you. Idle sessions sit in
the left sidebar above the decision log; click one to open it, click a card's
header to put it back. A session with a request waiting is never tucked into the
sidebar, whatever you collapsed earlier.

Drag the corner of a card to resize it. The card follows your pointer in raw
pixels while a dashed ghost marks the column it will snap to, then it animates
onto that boundary when you let go — the card never re-snaps mid-drag, because
re-snapping reflows the whole grid under your cursor and that is what makes a
resize feel jumpy. Sideways sets how many columns it spans, downwards grows its
conversation pane. Sizes are remembered per session, and the last size you chose
becomes the default for cards that appear later. Double-click the corner to
reset one.

Dark and light themes are in the top bar, following your system setting until
you pick one.

## Install

Requires Node 18+. No dependencies.

```bash
git clone https://github.com/m-peko/compa.git
cd compa
npm link            # or: node bin/compa.js <command>

compa install       # add the hooks to ~/.claude/settings.json
compa start         # run the dashboard, opens http://127.0.0.1:4517
```

`compa install` backs your settings file up to
`~/.claude/settings.json.compa-backup-<timestamp>` before touching it, and only
adds its own hook entries — anything already in `hooks` is left alone.

Claude Code re-reads its settings while running, so sessions you already have open
generally start routing to the dashboard within seconds. If one doesn't, restart it.

To remove it: `compa uninstall`.

## How it works

Claude Code fires a [`PermissionRequest`](https://code.claude.com/docs/en/hooks)
hook at the moment it is about to ask you to approve a tool call, and the hook's
response decides the outcome. compa registers an HTTP hook pointing at its own
local server:

1. A session wants to run something that needs permission.
2. Claude Code POSTs the request to compa and waits on the response.
3. The request appears in your browser, with the full command, diff or URL.
4. You click. compa answers the open request, and the session continues.

Because the decision rides on the hook response, there is no polling and no
keystroke injection — this is the interface Claude Code provides for exactly this
purpose.

Two smaller hooks fill in the gaps: `Notification` (matcher `permission_prompt`)
surfaces the few prompts that never raise a `PermissionRequest`, such as a
sandboxed command's network request, and `SessionEnd` clears a session's rows
when it exits.

### Sessions

Live sessions come from `~/.claude/sessions/*.json`, which Claude Code maintains
per process. Those files are never cleaned up, so compa filters them: a record
counts as live only if its pid exists **and** the process start time still matches
the `procStart` recorded in the file, which rules out a recycled pid. On a box with
131 session files, that typically leaves the 8 or so that are genuinely running.

A session counts as **active** — and so renders expanded — when it is busy, waiting
on a prompt, or holding a permission request. Everything else collapses to a tile.

Cards are ordered by when their session started, which never changes while it
runs, so the grid doesn't reshuffle underneath you: cards expand and collapse in
place, and a session that needs you is marked rather than moved. Sessions flip
between busy and idle constantly, so a card that was active stays open for 30
seconds after it settles instead of flapping shut.

### The conversation view

Expanded cards show the tail of the session's transcript from
`~/.claude/projects/<slug>/<id>.jsonl`: what you asked, what Claude said, and the
tool calls in between. Those files routinely pass several megabytes, so compa never
reads one whole — it seeks to the last 256KB, walks backwards until it has enough
turns, and caches the result against the file's size and mtime. Subagent chatter and
tool-result plumbing are filtered out so the thread stays readable.

Transcripts are read from disk and sent to your own browser over localhost. They
are not written to, and nothing leaves the machine.

### Requests you answer in the terminal

Claude Code shows its own prompt while the hook is still pending — whichever
answers first wins. If you answer in the terminal, it does **not** close the
hook's connection, so compa has no direct way to learn the request is settled and
the card would sit there forever.

What gives it away is the session's own status. Claude Code reports `waiting`
while a prompt is up and moves off it once the prompt is gone, so compa drops a
held request when its session has stopped waiting — either because it watched the
session enter `waiting` and leave it, or because the session has gone fully idle.
A five-second grace period covers the lag between the hook firing and the status
catching up. Those show up as `answered` in the sidebar.

### If compa isn't running

A failed connection to the hook is a non-blocking error in Claude Code: it simply
carries on with its normal permission flow and prompts in the terminal. Stopping
compa, or never starting it, changes nothing about how your sessions behave.

The same applies to anything compa is still holding when you quit it — every held
request is released back to the terminal prompt on shutdown.

### Timeouts

compa holds a request for 9 minutes (`COMPA_HOLD_MS`), just under the hook's
10-minute timeout, then releases it to the terminal prompt. Each card shows the
time remaining. Nothing gets stuck waiting on a browser tab you closed.

## Commands

| Command | |
| :-- | :-- |
| `compa start` | Run the dashboard. `--port N`, `--no-open` |
| `compa install` | Add hooks to `~/.claude/settings.json`. `--port N` |
| `compa status` | Show hooks, live sessions, server state |
| `compa uninstall` | Remove the hooks |

Press <kbd>A</kbd> anywhere in the dashboard to approve everything. Click a card
header to expand or collapse that session.

## About approving everything

**Approve all** grants every request currently on screen. They are all rendered in
full first — the command, the diff, the URL — so it is a bulk decision, not a blind
one.

**Auto-approve** is a different thing and the toggle asks you to confirm before it
turns on. While it is on, requests are granted the instant they arrive and you
never see them. That includes commands that delete files, rewrite history or reach
the network. It is the dashboard's equivalent of
`--dangerously-skip-permissions`, applied to every session at once. Leave it off
unless you know exactly what is running.

**Always allow** writes a permanent rule into `.claude/settings.local.json`, using
the rule Claude Code itself suggested for that request — the same thing the
terminal's "Yes, and don't ask again" does.

## Scope

The server binds to `127.0.0.1` only. Anyone who can reach the port can approve
tool calls on your machine, so don't put it on `0.0.0.0` or behind a tunnel
without authentication in front of it.

Session discovery reads `/proc` on Linux and falls back to a signal probe
elsewhere; the rest is platform-independent.

## License

MIT
