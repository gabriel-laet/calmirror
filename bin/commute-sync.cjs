#!/usr/bin/env node
'use strict';

// calmirror commute blocks: finds in-person appointments (events with a
// physical location) and adds traffic-aware travel blocks before/after them
// using the Google Routes API. Consecutive appointments are chained.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { loadConfig, expandHome } = require('../lib/config.cjs');
const { createGog, selfDeclined } = require('../lib/gog.cjs');

const config = loadConfig();
const gog = createGog(config.gog);
const commute = config.commute || {};
const TIMEZONE = config.timezone;
const P = config.propPrefix;
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const HOME_ADDRESS = process.env.CALMIRROR_HOME_ADDRESS || commute.homeAddress;
const COMMUTE_VERSION = 'v1';
const BUSY_SYNC_VERSION = 'v1';
const COLOR_ID = String(commute.colorId || '6');
const MARGIN_MINUTES = Number(commute.marginMinutes ?? 10);
const CHAIN_GAP_MINUTES = Number(commute.chainGapMinutes ?? 150);
const WINDOW_DAYS = Number(commute.windowDays ?? 21);
const TRAVEL_MODE = commute.travelMode || 'DRIVE';
const LANGUAGE = commute.languageCode || 'en-US';
const LABELS = {
  outbound: '🚗 Commute · outbound',
  between: '🚗 Commute · next appointment',
  return: '🚗 Commute · return',
  ...(commute.labels || {}),
};
const DESCRIPTION = commute.description || [
  'calmirror estimate: {minutes} min travel + {margin} min margin.',
  'Approx. distance: {distance}.',
  'From: {origin}',
  'To: {destination}',
  'For: {event}',
];
const DECIMAL_SEPARATOR = commute.decimalSeparator || '.';
const DEFAULT_TITLE = commute.defaultEventTitle || 'Appointment';
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DRY_RUN = process.argv.includes('--dry-run');
const now = Date.now();
const sourceFrom = new Date(now - 2 * DAY_MS).toISOString();
const sourceTo = new Date(now + WINDOW_DAYS * DAY_MS).toISOString();

const commuteAliases = commute.accounts || config.accounts.filter((a) => a.destination !== false).map((a) => a.alias);
const accounts = commuteAliases.map((alias, priority) => {
  const account = config.accounts.find((item) => item.alias === alias);
  if (!account) throw new Error(`commute.accounts references unknown alias ${alias}`);
  return { ...account, priority };
});

const onlinePattern = /(?:zoom|meet\.google|google\s+meet|teams\.microsoft|microsoft\s+teams|webex|videoconfer|videochamada|online|on-line|remot[oa]|remote|virtual)/i;
const physicalPattern = /(?:\d|street|st\.|avenue|ave\.|road|rd\.|rua|r\.|avenida|av\.|alameda|travessa|pra[cç]a|rodovia|estrada|shopping|mall|hotel|airport|aeroporto|terminal|restaurant|restaurante|gym|academia|cl[ií]nica|clinic|hospital)/i;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readApiKey() {
  if (process.env.GOOGLE_ROUTES_API_KEY) return process.env.GOOGLE_ROUTES_API_KEY.trim();
  const file = expandHome(process.env.CALMIRROR_ROUTES_KEY_FILE || commute.routesKeyFile || '');
  if (!file) throw new Error('set GOOGLE_ROUTES_API_KEY or commute.routesKeyFile');
  return fs.readFileSync(file, 'utf8').trim();
}

function isOnlineOnly(location) {
  return onlinePattern.test(location) && !physicalPattern.test(location);
}

function eventIdentity(account, event) {
  const start = event.start?.dateTime || event.start?.date || '';
  if (event.iCalUID) return `ical\u0000${event.iCalUID}\u0000${start}`;
  return `id\u0000${account.alias}\u0000${event.id}`;
}

function normalizePhysicalEvent(account, event) {
  const props = event.extendedProperties?.private || {};
  if (!event.id || event.status === 'cancelled') return null;
  if (props[`${P}_sync`] === BUSY_SYNC_VERSION) return null;
  if (props[`${P}_commute`] === COMMUTE_VERSION) return null;
  if (event.transparency === 'transparent') return null;
  if (event.eventType === 'workingLocation') return null;
  if (selfDeclined(event, account.account)) return null;
  if (!event.start?.dateTime || !event.end?.dateTime) return null;

  const location = String(event.location || '').trim();
  if (!location || isOnlineOnly(location)) return null;

  const startMs = Date.parse(event.start.dateTime);
  const endMs = Date.parse(event.end.dateTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (endMs < now - 60 * MINUTE_MS) return null;

  const identity = eventIdentity(account, event);
  return {
    key: hash(identity).slice(0, 48),
    identity,
    account,
    summary: String(event.summary || DEFAULT_TITLE).trim(),
    location,
    startMs,
    endMs,
    organizerSelf: event.organizer?.self === true || event.organizer?.email === account.account,
  };
}

function deduplicatePhysicalEvents(events) {
  const byIdentity = new Map();
  for (const event of events) {
    const current = byIdentity.get(event.identity);
    if (!current) {
      byIdentity.set(event.identity, event);
      continue;
    }
    const rank = (item) => (item.organizerSelf ? 0 : 10) + item.account.priority;
    if (rank(event) < rank(current)) byIdentity.set(event.identity, event);
  }
  return [...byIdentity.values()].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.key.localeCompare(b.key),
  );
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function planSegments(events) {
  const days = new Map();
  for (const event of events) {
    const day = dayFormatter.format(new Date(event.startMs));
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(event);
  }

  const segments = [];
  for (const dayEvents of days.values()) {
    dayEvents.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    for (let index = 0; index < dayEvents.length; index += 1) {
      const event = dayEvents[index];
      const previous = dayEvents[index - 1];
      const next = dayEvents[index + 1];
      const previousGap = previous ? event.startMs - previous.endMs : Infinity;
      const nextGap = next ? next.startMs - event.endMs : Infinity;
      const chainedFromPrevious = previous && previousGap >= 0 && previousGap <= CHAIN_GAP_MINUTES * MINUTE_MS;
      const chainedToNext = next && nextGap >= 0 && nextGap <= CHAIN_GAP_MINUTES * MINUTE_MS;

      if (event.startMs > now + 5 * MINUTE_MS) {
        segments.push({
          key: hash(`to\u0000${event.key}\u0000${chainedFromPrevious ? previous.key : 'home'}`).slice(0, 48),
          owner: event.account,
          sourceEvent: event,
          role: chainedFromPrevious ? 'between' : 'outbound',
          origin: chainedFromPrevious ? previous.location : HOME_ADDRESS,
          destination: event.location,
          routeDepartureMs: Math.max(now + MINUTE_MS, event.startMs - 45 * MINUTE_MS),
          anchorMs: event.startMs,
        });
      }
      if (!chainedToNext && event.endMs > now + 5 * MINUTE_MS) {
        segments.push({
          key: hash(`home\u0000${event.key}`).slice(0, 48),
          owner: event.account,
          sourceEvent: event,
          role: 'return',
          origin: event.location,
          destination: HOME_ADDRESS,
          routeDepartureMs: event.endMs,
          anchorMs: event.endMs,
        });
      }
    }
  }
  return segments;
}

// Refresh routes more often as departure approaches to limit API usage.
function refreshBucket(departureMs) {
  const delta = departureMs - now;
  if (delta <= 0) return 'current';
  const bucketMs = delta <= DAY_MS ? 30 * MINUTE_MS : delta <= 7 * DAY_MS ? 6 * 60 * MINUTE_MS : DAY_MS;
  return `${bucketMs}:${Math.floor(now / bucketMs)}`;
}

function parseDurationSeconds(value) {
  const match = String(value || '').match(/^([0-9]+(?:\.[0-9]+)?)s$/);
  return match ? Math.ceil(Number(match[1])) : NaN;
}

async function computeRoute(apiKey, segment) {
  const body = {
    origin: { address: segment.origin },
    destination: { address: segment.destination },
    travelMode: TRAVEL_MODE,
    languageCode: LANGUAGE,
    units: 'METRIC',
  };
  if (TRAVEL_MODE === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE';
  if (segment.routeDepartureMs > now + MINUTE_MS) body.departureTime = new Date(segment.routeDepartureMs).toISOString();

  const response = await fetch(ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = payload.error?.status || `HTTP_${response.status}`;
    const message = String(payload.error?.message || 'route request failed').replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`${status}: ${message}`);
  }
  const route = payload.routes?.[0];
  const durationSeconds = parseDurationSeconds(route?.duration);
  const distanceMeters = Number(route?.distanceMeters);
  if (!Number.isFinite(durationSeconds) || !Number.isFinite(distanceMeters)) throw new Error('Routes API returned no usable route');
  return { durationSeconds, distanceMeters };
}

function formatDistance(distanceMeters) {
  if (distanceMeters < 1000) return `${Math.round(distanceMeters)} m`;
  return `${(distanceMeters / 1000).toFixed(1).replace('.', DECIMAL_SEPARATOR)} km`;
}

function buildDesired(segment, route, routeCache) {
  const routeMinutes = Math.max(1, Math.ceil(route.durationSeconds / 60));
  const blockedMs = Math.ceil((routeMinutes + MARGIN_MINUTES) / 5) * 5 * MINUTE_MS;
  const startMs = segment.role === 'return' ? segment.anchorMs : segment.anchorMs - blockedMs;
  const endMs = segment.role === 'return' ? segment.anchorMs + blockedMs : segment.anchorMs;
  const summary = LABELS[segment.role];
  const values = {
    minutes: routeMinutes,
    margin: MARGIN_MINUTES,
    distance: formatDistance(route.distanceMeters),
    origin: segment.origin,
    destination: segment.destination,
    event: segment.sourceEvent.summary,
  };
  const description = DESCRIPTION
    .map((line) => line.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match)))
    .join('\n');
  const fingerprint = hash(JSON.stringify({ startMs, endMs, summary, description, destination: segment.destination, routeCache })).slice(0, 48);

  return {
    key: segment.key,
    fingerprint,
    body: {
      summary,
      description,
      location: segment.destination,
      colorId: COLOR_ID,
      start: { dateTime: new Date(startMs).toISOString(), timeZone: TIMEZONE },
      end: { dateTime: new Date(endMs).toISOString(), timeZone: TIMEZONE },
      transparency: 'opaque',
      visibility: 'private',
      reminders: { useDefault: false },
      extendedProperties: {
        private: {
          [`${P}_commute`]: COMMUTE_VERSION,
          [`${P}_key`]: segment.key,
          [`${P}_source_event`]: segment.sourceEvent.key,
          [`${P}_role`]: segment.role,
          [`${P}_route_cache`]: routeCache,
          [`${P}_fingerprint`]: fingerprint,
          [`${P}_duration_s`]: String(route.durationSeconds),
          [`${P}_distance_m`]: String(route.distanceMeters),
        },
      },
    },
  };
}

function apiMutation(account, method, params, body) {
  if (DRY_RUN) return {};
  return gog.run(account, gog.mutationArgs(method, params, body));
}

function indexExisting(events) {
  const byKey = new Map();
  const duplicates = [];
  for (const event of events) {
    const key = event.extendedProperties?.private?.[`${P}_key`];
    if (!key || byKey.has(key)) duplicates.push(event);
    else byKey.set(key, event);
  }
  return { byKey, duplicates };
}

async function main() {
  if (!HOME_ADDRESS) throw new Error('set CALMIRROR_HOME_ADDRESS or commute.homeAddress');
  const apiKey = readApiKey();
  if (!apiKey) throw new Error('Routes API key is empty');

  const allPhysical = [];
  const sourceCounts = {};
  const existingByAccount = new Map();
  for (const account of accounts) {
    const physical = gog.listEvents(account, sourceFrom, sourceTo)
      .map((event) => normalizePhysicalEvent(account, event))
      .filter(Boolean);
    sourceCounts[account.alias] = physical.length;
    allPhysical.push(...physical);
    existingByAccount.set(
      account.alias,
      indexExisting(gog.listEvents(account, sourceFrom, sourceTo, `${P}_commute=${COMMUTE_VERSION}`)),
    );
  }

  const physicalEvents = deduplicatePhysicalEvents(allPhysical);
  const segments = planSegments(physicalEvents);
  const desiredByAccount = new Map(accounts.map((account) => [account.alias, new Map()]));
  const routeErrors = [];
  let routesRequested = 0;
  let routesReused = 0;

  for (const segment of segments) {
    const routeCache = hash(JSON.stringify({
      version: COMMUTE_VERSION,
      origin: segment.origin,
      destination: segment.destination,
      departureMs: segment.routeDepartureMs,
      anchorMs: segment.anchorMs,
      bucket: refreshBucket(segment.routeDepartureMs),
    })).slice(0, 48);
    const existing = existingByAccount.get(segment.owner.alias).byKey.get(segment.key);
    const props = existing?.extendedProperties?.private || {};
    const cachedDuration = Number(props[`${P}_duration_s`]);
    const cachedDistance = Number(props[`${P}_distance_m`]);

    let route;
    if (props[`${P}_route_cache`] === routeCache && Number.isFinite(cachedDuration) && Number.isFinite(cachedDistance)) {
      route = { durationSeconds: cachedDuration, distanceMeters: cachedDistance };
      routesReused += 1;
    } else {
      try {
        route = await computeRoute(apiKey, segment);
        routesRequested += 1;
      } catch (error) {
        routeErrors.push({
          account: segment.owner.alias,
          role: segment.role,
          error: error instanceof Error ? error.message : String(error),
        });
        if (existing) desiredByAccount.get(segment.owner.alias).set(segment.key, { key: segment.key, preserveExisting: true });
        continue;
      }
    }
    desiredByAccount.get(segment.owner.alias).set(segment.key, buildDesired(segment, route, routeCache));
  }

  const reconciliation = [];
  for (const account of accounts) {
    const calendarId = account.calendarId || 'primary';
    const desired = desiredByAccount.get(account.alias);
    const { byKey: existing, duplicates } = existingByAccount.get(account.alias);
    const stats = { account: account.alias, desired: desired.size, existing: existing.size + duplicates.length, created: 0, updated: 0, deleted: 0, unchanged: 0 };

    for (const [key, item] of desired) {
      const current = existing.get(key);
      if (item.preserveExisting && current) {
        stats.unchanged += 1;
        existing.delete(key);
        continue;
      }
      if (!current) {
        apiMutation(account, 'calendar.events.insert', { calendarId, sendUpdates: 'none' }, item.body);
        stats.created += 1;
        continue;
      }
      if (current.extendedProperties?.private?.[`${P}_fingerprint`] !== item.fingerprint) {
        apiMutation(account, 'calendar.events.patch', { calendarId, eventId: current.id, sendUpdates: 'none' }, item.body);
        stats.updated += 1;
      } else {
        stats.unchanged += 1;
      }
      existing.delete(key);
    }
    for (const stale of [...existing.values(), ...duplicates]) {
      if (!stale.id) continue;
      apiMutation(account, 'calendar.events.delete', { calendarId, eventId: stale.id, sendUpdates: 'none' });
      stats.deleted += 1;
    }
    reconciliation.push(stats);
  }

  process.stdout.write(`${JSON.stringify({
    ok: routeErrors.length === 0,
    dryRun: DRY_RUN,
    window: { from: sourceFrom, to: sourceTo },
    sourceCounts,
    uniquePhysicalEvents: physicalEvents.length,
    plannedSegments: segments.length,
    routesRequested,
    routesReused,
    routeErrors,
    reconciliation,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`calmirror commute sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
