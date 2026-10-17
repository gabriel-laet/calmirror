'use strict';

const { spawn, spawnSync } = require('node:child_process');

function createGog(gogBin) {
  function run(account, args) {
    const result = spawnSync(
      gogBin,
      [`--account=${account.account}`, '--json', '--no-input', ...args],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || 'unknown gog error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
      throw new Error(`${account.alias}: gog exited ${result.status}: ${detail}`);
    }
    const output = String(result.stdout || '').trim();
    return output ? JSON.parse(output) : {};
  }

  function listEvents(account, from, to, privateFilter) {
    const args = [
      '--readonly',
      'calendar',
      'events',
      account.calendarId || 'primary',
      `--from=${from}`,
      `--to=${to}`,
      '--all-pages',
      '--max=2500',
    ];
    if (privateFilter) args.push(`--private-prop-filter=${privateFilter}`);
    const response = run(account, args);
    return Array.isArray(response.events) ? response.events : [];
  }

  function mutationArgs(method, params, body) {
    const args = ['--force', 'api', 'call', 'calendar', 'v3', method, `--params=${JSON.stringify(params)}`];
    if (body) args.push(`--body=${JSON.stringify(body)}`);
    args.push('--allow-write');
    return args;
  }

  function runAsyncOnce(account, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        gogBin,
        [`--account=${account.account}`, '--json', '--no-input', ...args],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 4_000) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        const detail = stderr.replace(/\s+/g, ' ').trim().slice(0, 600);
        reject(new Error(`${account.alias}: gog mutation failed (${signal || code}): ${detail || 'no details'}`));
      });
    });
  }

  async function runAsync(account, args) {
    const retryDelays = [3_000, 6_000, 12_000, 24_000, 48_000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await runAsyncOnce(account, args);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = /rateLimitExceeded|Rate Limit Exceeded|usageLimits|HTTP 429/i.test(message);
        if (!retryable || attempt >= retryDelays.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
      }
    }
  }

  return { run, listEvents, mutationArgs, runAsync };
}

function selfDeclined(event, email) {
  if (!Array.isArray(event.attendees)) return false;
  return event.attendees.some(
    (attendee) =>
      (attendee.self === true || attendee.email === email) &&
      attendee.responseStatus === 'declined',
  );
}

module.exports = { createGog, selfDeclined };
