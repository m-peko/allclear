'use strict';

const os = require('os');
const path = require('path');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

module.exports = {
  CLAUDE_DIR,
  SESSIONS_DIR: path.join(CLAUDE_DIR, 'sessions'),
  SETTINGS_FILE: path.join(CLAUDE_DIR, 'settings.json'),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
  DEFAULT_PORT: Number(process.env.ALLCLEAR_PORT || 4517),
};
