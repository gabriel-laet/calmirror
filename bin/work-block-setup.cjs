#!/usr/bin/env node
'use strict';

// One-off: creates the recurring "Work Mode" busy block(s) in
// workMode.blockAccount from workMode.schedule. Idempotent.
// calendar-sync.cjs then stretches each day's block to cover real work events.

const { loadConfig, zonedToUtc, parseHHMM } = require('../lib/config.cjs');
const { createGog } = require('../lib/gog.cjs');

const config = loadConfig();
const gog = createGog(config.gog);
const P = config.propPrefix;
const TIMEZONE = config.timezone;
const VERSION = 'v1';
const workMode = config.workMode || {};
const account = config.accounts.find((item) => item.alias === workMode.blockAccount);
const DAY_CODES = { Mon: 'MO', Tue: 'TU', Wed: 'WE', Thu: 'TH', Fri: 'FR', Sat: 'SA', Sun: 'SU' };
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function nextDayKey(weekday) {
  const date = new Date();
  const delta = (DAY_INDEX[weekday] - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function schedules() {
  // Group weekdays sharing the same window into one recurring event.
  const groups = new Map();
  for (const [day, range] of Object.entries(workMode.schedule || {})) {
    if (!DAY_CODES[day]) throw new Error(`unknown weekday ${day} (use Mon..Sun)`);
    const id = `${range[0]}-${range[1]}`;
    if (!groups.has(id)) groups.set(id, { range, days: [] });
    groups.get(id).days.push(day);
  }
  return [...groups.values()].map(({ range, days }) => {
    const first = days[0];
    const dayKey = nextDayKey(first);
    return {
      key: `${days.map((d) => DAY_CODES[d].toLowerCase()).join('-')}-${range[0].replace(':', '')}-${range[1].replace(':', '')}`,
      start: new Date(zonedToUtc(dayKey, parseHHMM(range[0]), TIMEZONE)).toISOString(),
      end: new Date(zonedToUtc(dayKey, parseHHMM(range[1]), TIMEZONE)).toISOString(),
      recurrence: `RRULE:FREQ=WEEKLY;BYDAY=${days.map((d) => DAY_CODES[d]).join(',')}`,
    };
  });
}

function main() {
  if (!account) throw new Error('workMode.blockAccount must reference a configured alias');
  const from = new Date(Date.now() - 400 * 864e5).toISOString();
  const to = new Date(Date.now() + 400 * 864e5).toISOString();
  const existing = gog.listEvents(account, from, to, `${P}_work_block=${VERSION}`);
  const existingKeys = new Set(existing.map((e) => e.extendedProperties?.private?.[`${P}_schedule`]).filter(Boolean));
  let created = 0;
  for (const schedule of schedules()) {
    if (existingKeys.has(schedule.key)) continue;
    const body = {
      summary: workMode.summary || '💻 Work Mode',
      description: 'Managed by calmirror. Stretched daily to cover real work events.',
      colorId: String(workMode.colorId || '8'),
      start: { dateTime: schedule.start, timeZone: TIMEZONE },
      end: { dateTime: schedule.end, timeZone: TIMEZONE },
      recurrence: [schedule.recurrence],
      transparency: 'opaque',
      visibility: 'private',
      reminders: { useDefault: false },
      extendedProperties: { private: { [`${P}_work_block`]: VERSION, [`${P}_schedule`]: schedule.key } },
    };
    if (!process.argv.includes('--dry-run')) {
      gog.run(account, gog.mutationArgs('calendar.events.insert', { calendarId: account.calendarId || 'primary', sendUpdates: 'none' }, body));
    }
    created += 1;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, existingSchedules: existingKeys.size, created })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`calmirror Work Mode setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
