'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandHome(value) {
  if (typeof value !== 'string') return value;
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function defaultConfigPath() {
  if (process.env.CALMIRROR_CONFIG) return expandHome(process.env.CALMIRROR_CONFIG);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'calmirror', 'config.json');
}

function loadConfig() {
  const file = defaultConfigPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read config ${file}: ${error.message} (copy config.example.json there or set CALMIRROR_CONFIG)`);
  }
  const config = JSON.parse(raw);
  if (!Array.isArray(config.accounts) || config.accounts.length < 2) {
    throw new Error('config.accounts must list at least two calendars');
  }
  const aliases = new Set();
  for (const account of config.accounts) {
    if (!account.alias || !account.account) {
      throw new Error('every account needs "alias" and "account" (the gog account email)');
    }
    if (aliases.has(account.alias)) throw new Error(`duplicate alias ${account.alias}`);
    aliases.add(account.alias);
  }
  return {
    ...config,
    gog: expandHome(process.env.CALMIRROR_GOG || config.gog || 'gog'),
    timezone: process.env.CALMIRROR_TZ || config.timezone || 'UTC',
    propPrefix: config.propPrefix || 'calmirror',
  };
}

// Convert a local wall-clock time in `timeZone` into a UTC timestamp (ms).
function zonedToUtc(dayKey, minuteOfDay, timeZone) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  const offset = zoneOffsetMs(guess, timeZone);
  const first = guess - offset;
  const second = guess - zoneOffsetMs(first, timeZone);
  return second;
}

function zoneOffsetMs(timestamp, timeZone) {
  const parts = {};
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  for (const part of formatter.formatToParts(new Date(timestamp))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(timestamp / 1000) * 1000;
}

function parseHHMM(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error(`invalid time "${value}", expected HH:MM`);
  return Number(match[1]) * 60 + Number(match[2]);
}

module.exports = { loadConfig, zonedToUtc, parseHHMM, expandHome };
