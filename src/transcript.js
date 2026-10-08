'use strict';

// Reads the recent conversation out of a session's transcript.
//
// Transcripts are append-only JSONL under ~/.claude/projects/<slug>/<id>.jsonl and
// routinely run to several megabytes, so nothing here ever reads a whole file: it
// seeks to the last slice of bytes and walks backwards until it has enough
// renderable turns. Results are cached per file and invalidated on size/mtime.

const fs = require('fs');
const path = require('path');
const { CLAUDE_DIR } = require('./paths');

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TAIL_BYTES = 256 * 1024;
const MAX_TEXT = 600;

const pathCache = new Map(); // sessionId -> transcript path (or null)
const tailCache = new Map(); // path -> { size, mtimeMs, events }

function locate(sessionId) {
  if (pathCache.has(sessionId)) {
    const cached = pathCache.get(sessionId);
    if (cached && fs.existsSync(cached)) return cached;
    pathCache.delete(sessionId);
  }

  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    const candidate = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      pathCache.set(sessionId, candidate);
      return candidate;
    }
  }
  pathCache.set(sessionId, null);
  return null;
}

function tailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return [];
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is almost certainly truncated
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function clean(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim();
}

function shorten(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

// One-line gist of a tool call, so the chat reads like a log rather than JSON.
function toolSummary(name, input) {
  const i = input || {};
  switch (name) {
    case 'Bash':
      return i.command || '';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return i.file_path || '';
    case 'Grep':
      return `${i.pattern || ''}${i.path ? ` in ${i.path}` : ''}`;
    case 'Glob':
      return i.pattern || '';
    case 'WebFetch':
      return i.url || '';
    case 'WebSearch':
      return i.query || '';
    case 'Task':
    case 'Agent':
      return i.description || i.subagent_type || '';
    case 'TodoWrite':
      return Array.isArray(i.todos) ? `${i.todos.length} items` : '';
    default: {
      const json = JSON.stringify(i) || '';
      return json.length > 120 ? `${json.slice(0, 120)}…` : json;
    }
  }
}

function blocksOf(entry) {
  const content = entry && entry.message && entry.message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

// Walks newest-first and stops once `limit` events are collected.
function buildEvents(lines, limit) {
  const events = [];

  for (let index = lines.length - 1; index >= 0 && events.length < limit; index -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }

    const kind = entry.type;
    if (kind !== 'user' && kind !== 'assistant') continue;
    if (entry.isSidechain) continue; // subagent chatter, not the main thread

    const blocks = blocksOf(entry);
    const at = Date.parse(entry.timestamp) || null;

    // A `user` entry carrying tool results is plumbing, not something anyone said.
    if (kind === 'user' && (entry.toolUseResult || blocks.some((b) => b.type === 'tool_result'))) {
      continue;
    }

    const local = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        const text = clean(block.text);
        if (text) local.push({ role: kind, text: shorten(text), at });
      } else if (block.type === 'tool_use') {
        local.push({
          role: 'tool',
          tool: block.name || 'tool',
          text: shorten(toolSummary(block.name, block.input)),
          at,
        });
      }
    }

    // Blocks were read in order within the entry; unshift keeps the transcript
    // chronological as the outer loop moves backwards.
    for (let j = local.length - 1; j >= 0 && events.length < limit; j -= 1) {
      events.unshift(local[j]);
    }
  }

  return events;
}

function read(sessionId, limit = 12) {
  const file = locate(sessionId);
  if (!file) return [];

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }

  const cached = tailCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.events.slice(-limit);
  }

  let events = [];
  try {
    events = buildEvents(tailLines(file), Math.max(limit, 20));
  } catch {
    events = [];
  }

  tailCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, events });
  if (tailCache.size > 64) tailCache.delete(tailCache.keys().next().value);

  return events.slice(-limit);
}

module.exports = { read };
