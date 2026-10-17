#!/usr/bin/env node
'use strict';

// calmirror busy-block sync: mirrors every busy event from each configured
// Google calendar into the others as a private, detail-free "Busy" block,
// and keeps the optional Work Mode block/markers aligned with the real day.

const crypto = require('node:crypto');
const { loadConfig, zonedToUtc, parseHHMM } = require('../lib/config.cjs');
const { createGog, selfDeclined } = require('../lib/gog.cjs');

const config = loadConfig();
const gog = createGog(config.gog);
const TIMEZONE = config.timezone;
const P = config.propPrefix;
const SYNC_VERSION = 'v1';
const WORK_BLOCK_VERSION = 'v1';
const sync = config.sync || {};
const MIXED_COLOR_ID = String(sync.mixedColorId || '8');
const MAX_MUTATION_CONCURRENCY = Number(sync.concurrency || 2);
const BUSY_TEMPLATE = sync.busySummary || 'Busy — {labels}';
const WORK_MARKER_DURATION_MS = Number(config.workMode?.markerMinutes || 15) * 60 * 1000;
const DRY_RUN = process.argv.includes('--dry-run');
const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const sourceFrom = new Date(now - 2 * DAY_MS).toISOString();
const sourceTo = new Date(now + Number(sync.windowDays || 180) * DAY_MS).toISOString();
const shadowFrom = new Date(now - 30 * DAY_MS).toISOString();
const shadowTo = new Date(now + 365 * DAY_MS).toISOString();

const accounts = config.accounts;
const byAlias = new Map(accounts.map((account) => [account.alias, account]));
const mutationQueue = [];
let smartWorkWindows = new Map();

const workMode = config.workMode && config.workMode.enabled !== false ? config.workMode : null;
const workWindowByWeekday = {};
if (workMode) {
  for (const [day, range] of Object.entries(workMode.schedule || {})) {
    workWindowByWeekday[day] = [parseHHMM(range[0]), parseHHMM(range[1])];
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function styleFor(alias) {
  const account = byAlias.get(alias);
  return { label: account.label || alias, colorId: String(account.colorId || '8') };
}

function cleanBoundary(boundary) {
  if (boundary && typeof boundary.date === 'string') return { date: boundary.date };
  if (boundary && typeof boundary.dateTime === 'string') {
    return {
      dateTime: boundary.dateTime,
      timeZone: typeof boundary.timeZone === 'string' && boundary.timeZone ? boundary.timeZone : TIMEZONE,
    };
  }
  return null;
}

function originalIdentity(account, event) {
  if (typeof event.iCalUID === 'string' && event.iCalUID) {
    const instance = event.recurringEventId
      ? event.originalStartTime?.dateTime ||
        event.originalStartTime?.date ||
        event.start?.dateTime ||
        event.start?.date ||
        event.id
      : 'single';
    return `ical\u0000${event.iCalUID}\u0000${instance}`;
  }
  return `id\u0000${account.alias}\u0000${event.id}`;
}

function normalizeOriginal(account, event) {
  const props = event.extendedProperties?.private || {};
  if (props[`${P}_sync`] === SYNC_VERSION) return null;
  if (props[`${P}_work_block`] === WORK_BLOCK_VERSION) return null;
  if (!event.id || event.status === 'cancelled') return null;
  if (event.transparency === 'transparent') return null;
  if (event.eventType === 'workingLocation') return null;
  if (selfDeclined(event, account.account)) return null;

  const start = cleanBoundary(event.start);
  const end = cleanBoundary(event.end);
  if (!start || !end) return null;

  const key = hash(originalIdentity(account, event)).slice(0, 48);
  const allDay = Boolean(start.date && end.date);
  const startMs = allDay ? Date.parse(`${start.date}T00:00:00Z`) : Date.parse(start.dateTime);
  const endMs = allDay ? Date.parse(`${end.date}T00:00:00Z`) : Date.parse(end.dateTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  // Optional: short timed entries (e.g. routine reminders in a shared calendar)
  // should not reserve time elsewhere.
  const ignoreMin = Number(account.ignoreEventsUpToMinutes || 0);
  if (ignoreMin > 0 && !allDay && endMs - startMs <= ignoreMin * 60 * 1000) return null;

  return { key, source: account.alias, start, end, startMs, endMs, allDay };
}

const workWindowFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function localWorkParts(timestamp) {
  const values = {};
  for (const part of workWindowFormatter.formatToParts(new Date(timestamp))) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    dayKey: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday,
    minute: Number(values.hour) * 60 + Number(values.minute),
  };
}

function coveredByWorkBlock(candidate) {
  if (candidate.allDay) return false;
  const start = localWorkParts(candidate.startMs);
  const end = localWorkParts(candidate.endMs);
  if (start.dayKey !== end.dayKey) return false;
  const window = workWindowByWeekday[start.weekday];
  if (!window) return false;
  const smartWindow = smartWorkWindows.get(start.dayKey);
  if (smartWindow) {
    return candidate.startMs >= smartWindow.startMs && candidate.endMs <= smartWindow.endMs;
  }
  return start.minute >= window[0] && end.minute <= window[1];
}

function boundaryAt(timestamp) {
  return { dateTime: new Date(timestamp).toISOString(), timeZone: TIMEZONE };
}

function baseWorkWindow(dayKey, weekday) {
  const window = workWindowByWeekday[weekday];
  if (!window) return null;
  return {
    startMs: zonedToUtc(dayKey, window[0], TIMEZONE),
    endMs: zonedToUtc(dayKey, window[1], TIMEZONE),
  };
}

function computeSmartWorkWindows(originalsByAlias) {
  const windows = new Map();
  if (!workMode) return windows;
  for (const alias of workMode.workAccounts || []) {
    const originals = originalsByAlias.get(alias);
    if (!originals) continue;
    for (const candidate of originals.values()) {
      if (candidate.allDay) continue;
      const start = localWorkParts(candidate.startMs);
      const end = localWorkParts(candidate.endMs);
      if (start.dayKey !== end.dayKey) continue;
      const base = baseWorkWindow(start.dayKey, start.weekday);
      if (!base) continue;
      const current = windows.get(start.dayKey) || base;
      current.startMs = Math.min(current.startMs, candidate.startMs);
      current.endMs = Math.max(current.endMs, candidate.endMs);
      windows.set(start.dayKey, current);
    }
  }
  return windows;
}

function desiredWindowForEvent(event) {
  const boundary = cleanBoundary(event.start);
  if (!boundary || !boundary.dateTime) return null;
  const parts = localWorkParts(Date.parse(boundary.dateTime));
  return smartWorkWindows.get(parts.dayKey) || baseWorkWindow(parts.dayKey, parts.weekday);
}

function apiMutation(account, method, params, body) {
  if (DRY_RUN) return;
  mutationQueue.push({ account, args: gog.mutationArgs(method, params, body) });
}

function reconcileSmartWorkMode() {
  const stats = { workBlocksUpdated: 0, startMarkersUpdated: 0, endMarkersUpdated: 0 };
  if (!workMode) return stats;
  const blockAccount = byAlias.get(workMode.blockAccount);
  const markerAccount = workMode.markerAccount ? byAlias.get(workMode.markerAccount) : null;

  function patchBoundary(account, event, startMs, endMs, statKey) {
    if (!event.id || !event.start?.dateTime || !event.end?.dateTime) return;
    if (Date.parse(event.start.dateTime) === startMs && Date.parse(event.end.dateTime) === endMs) return;
    apiMutation(
      account,
      'calendar.events.patch',
      { calendarId: account.calendarId || 'primary', eventId: event.id, sendUpdates: 'none' },
      { start: boundaryAt(startMs), end: boundaryAt(endMs) },
    );
    stats[statKey] += 1;
  }

  if (blockAccount) {
    for (const event of gog.listEvents(blockAccount, sourceFrom, sourceTo, `${P}_work_block=${WORK_BLOCK_VERSION}`)) {
      const desired = desiredWindowForEvent(event);
      if (desired) patchBoundary(blockAccount, event, desired.startMs, desired.endMs, 'workBlocksUpdated');
    }
  }
  if (markerAccount) {
    for (const event of gog.listEvents(markerAccount, sourceFrom, sourceTo, `${P}_marker=work_start`)) {
      const desired = desiredWindowForEvent(event);
      if (desired) {
        patchBoundary(markerAccount, event, desired.startMs - WORK_MARKER_DURATION_MS, desired.startMs, 'startMarkersUpdated');
      }
    }
    for (const event of gog.listEvents(markerAccount, sourceFrom, sourceTo, `${P}_marker=work_end`)) {
      const desired = desiredWindowForEvent(event);
      if (desired) {
        patchBoundary(markerAccount, event, desired.endMs, desired.endMs + WORK_MARKER_DURATION_MS, 'endMarkersUpdated');
      }
    }
  }
  return stats;
}

function buildMergedBlock(group) {
  const order = (alias) => accounts.findIndex((item) => item.alias === alias);
  const sources = [...group.sources].sort((a, b) => order(a) - order(b));
  const memberKeys = [...group.memberKeys].sort();
  const key = memberKeys.length === 1 ? memberKeys[0] : hash(`merged\u0000${memberKeys.join('\u0000')}`).slice(0, 48);
  const styles = [...new Map(sources.map((source) => [styleFor(source).label, styleFor(source)])).values()];
  const summary = BUSY_TEMPLATE.replace('{labels}', styles.map((style) => style.label).join(' + '));
  const colorId = styles.length === 1 ? styles[0].colorId : MIXED_COLOR_ID;
  const fingerprint = hash(JSON.stringify({ start: group.start, end: group.end, sources, summary, colorId })).slice(0, 48);

  return {
    key,
    fingerprint,
    body: {
      summary,
      colorId,
      start: group.start,
      end: group.end,
      transparency: 'opaque',
      visibility: 'private',
      reminders: { useDefault: false },
      extendedProperties: {
        private: {
          [`${P}_sync`]: SYNC_VERSION,
          [`${P}_key`]: key,
          [`${P}_source`]: sources.join('+'),
          [`${P}_fingerprint`]: fingerprint,
        },
      },
    },
  };
}

function mergeCandidates(candidates) {
  const unique = new Map();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.key);
    if (!existing) {
      unique.set(candidate.key, { ...candidate, sources: new Set([candidate.source]), memberKeys: new Set([candidate.key]) });
      continue;
    }
    existing.sources.add(candidate.source);
    if (candidate.startMs < existing.startMs) {
      existing.startMs = candidate.startMs;
      existing.start = candidate.start;
    }
    if (candidate.endMs > existing.endMs) {
      existing.endMs = candidate.endMs;
      existing.end = candidate.end;
    }
  }

  const sorted = [...unique.values()].sort(
    (a, b) => Number(a.allDay) - Number(b.allDay) || a.startMs - b.startMs || a.endMs - b.endMs,
  );
  const groups = [];
  for (const candidate of sorted) {
    const current = groups.at(-1);
    if (current && current.allDay === candidate.allDay && candidate.startMs <= current.endMs) {
      if (candidate.endMs > current.endMs) {
        current.endMs = candidate.endMs;
        current.end = candidate.end;
      }
      for (const source of candidate.sources) current.sources.add(source);
      for (const memberKey of candidate.memberKeys) current.memberKeys.add(memberKey);
      continue;
    }
    groups.push({ ...candidate, sources: new Set(candidate.sources), memberKeys: new Set(candidate.memberKeys) });
  }
  return groups.map(buildMergedBlock);
}

async function flushMutations() {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < mutationQueue.length) {
      const item = mutationQueue[nextIndex];
      nextIndex += 1;
      await gog.runAsync(item.account, item.args);
    }
  }
  const workerCount = Math.min(MAX_MUTATION_CONCURRENCY, mutationQueue.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return mutationQueue.length;
}

function reconcileDestination(destination, originalsByAlias) {
  const candidates = [];
  const destinationOriginals = originalsByAlias.get(destination.alias);
  const calendarId = destination.calendarId || 'primary';

  for (const source of accounts) {
    if (source.alias === destination.alias) continue;
    if (Array.isArray(source.skipDestinations) && source.skipDestinations.includes(destination.alias)) continue;
    for (const [key, normalized] of originalsByAlias.get(source.alias)) {
      if (destinationOriginals.has(key)) continue; // same invite already there
      if (workMode && destination.alias === workMode.blockAccount && coveredByWorkBlock(normalized)) continue;
      candidates.push(normalized);
    }
  }

  const desired = new Map(mergeCandidates(candidates).map((block) => [block.key, block]));
  const existingEvents = gog.listEvents(destination, shadowFrom, shadowTo, `${P}_sync=${SYNC_VERSION}`);
  const existingByKey = new Map();
  const duplicates = [];
  for (const event of existingEvents) {
    const key = event.extendedProperties?.private?.[`${P}_key`];
    if (!key || existingByKey.has(key)) duplicates.push(event);
    else existingByKey.set(key, event);
  }

  const stats = {
    destination: destination.alias,
    candidates: candidates.length,
    desired: desired.size,
    merged: candidates.length - desired.size,
    existing: existingEvents.length,
    created: 0,
    updated: 0,
    deleted: 0,
  };

  for (const [key, block] of desired) {
    const existing = existingByKey.get(key);
    if (!existing) {
      apiMutation(destination, 'calendar.events.insert', { calendarId, sendUpdates: 'none' }, block.body);
      stats.created += 1;
      continue;
    }
    if (existing.extendedProperties?.private?.[`${P}_fingerprint`] !== block.fingerprint) {
      apiMutation(destination, 'calendar.events.patch', { calendarId, eventId: existing.id, sendUpdates: 'none' }, block.body);
      stats.updated += 1;
    }
    existingByKey.delete(key);
  }
  for (const stale of [...existingByKey.values(), ...duplicates]) {
    if (!stale.id) continue;
    apiMutation(destination, 'calendar.events.delete', { calendarId, eventId: stale.id, sendUpdates: 'none' });
    stats.deleted += 1;
  }
  return stats;
}

async function main() {
  const originalsByAlias = new Map();
  const sourceCounts = {};
  for (const account of accounts) {
    const originals = new Map();
    for (const event of gog.listEvents(account, sourceFrom, sourceTo)) {
      const normalized = normalizeOriginal(account, event);
      if (normalized) originals.set(normalized.key, normalized);
    }
    originalsByAlias.set(account.alias, originals);
    sourceCounts[account.alias] = originals.size;
  }

  smartWorkWindows = computeSmartWorkWindows(originalsByAlias);
  const smartWorkMode = reconcileSmartWorkMode();
  const destinations = accounts
    .filter((account) => account.destination !== false)
    .map((account) => reconcileDestination(account, originalsByAlias));
  const mutationsApplied = await flushMutations();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dryRun: DRY_RUN,
    window: { from: sourceFrom, to: sourceTo },
    sourceCounts,
    smartWorkMode,
    destinations,
    mutationsApplied,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`calmirror calendar sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
