#!/usr/bin/env node
/**
 * cron-runner.js — Runs scheduled Claude Code jobs defined in crons/jobs.json.
 *
 * Each job spawns `claude --dangerously-skip-permissions -p "<message>"` on schedule.
 * No external cron library needed — uses a built-in minute-tick loop.
 *
 * Usage:
 *   node scripts/cron-runner.js              # start daemon
 *   node scripts/cron-runner.js --run <id>   # fire one job immediately and exit
 *
 * Environment:
 *   DISCORD_BOT_TOKEN  — for posting results/errors to Discord
 *   CRON_TZ            — default timezone for jobs (e.g. America/Denver)
 *   WORKSPACE_DIR      — workspace root (default: /workspace)
 *   CLAUDE_BIN         — override claude binary path (default: auto-resolved)
 *
 * Manual trigger (without restarting daemon):
 *   touch crons/triggers/<jobId>.trigger
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace';

// Resolve claude binary at startup — PATH is often stripped in restart-loop
// shells, causing ENOENT even when claude is installed.
const CLAUDE_BIN = (() => {
  const candidates = [
    process.env.CLAUDE_BIN,
    '/usr/local/bin/claude',
    '/home/node/.npm-global/bin/claude',
  ].filter(Boolean);
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return 'claude'; // last resort — let the OS produce the error
})();

const JOBS_FILE    = path.join(WORKSPACE, 'crons', 'jobs.json');
const LOG_DIR      = path.join(WORKSPACE, 'crons', 'logs');
const TRIGGERS_DIR = path.join(WORKSPACE, 'crons', 'triggers');
const LOCK_FILE    = path.join(WORKSPACE, 'crons', 'cron-runner.pid');
const DEFAULT_TZ   = process.env.CRON_TZ || 'America/Denver';
const DISCORD_POST = path.join(WORKSPACE, 'scripts', 'discord-post.js');

// Crons always use sonnet by default — keeps costs predictable.
// Override per-job with a "model" field in jobs.json.
const CRON_DEFAULT_MODEL = 'sonnet';

// ── Cron expression parser ────────────────────────────────────────────────────

function parseCronField(field, min, max) {
  if (field === '*') return null;
  const values = new Set();
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, step] = part.split('/');
      const s = parseInt(step, 10);
      const start = range === '*' ? min : parseInt(range.split('-')[0], 10);
      const end   = range === '*' ? max : (range.includes('-') ? parseInt(range.split('-')[1], 10) : max);
      for (let i = start; i <= end; i += s) values.add(i);
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      for (let i = lo; i <= hi; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }
  return values;
}

function cronMatches(expr, date) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;
  const min  = parseCronField(minF,  0, 59);
  const hour = parseCronField(hourF, 0, 23);
  const dom  = parseCronField(domF,  1, 31);
  const mon  = parseCronField(monF,  1, 12);
  const dow  = parseCronField(dowF,  0,  6);
  if (min  && !min.has(date.getMinutes()))     return false;
  if (hour && !hour.has(date.getHours()))      return false;
  if (dom  && !dom.has(date.getDate()))        return false;
  if (mon  && !mon.has(date.getMonth() + 1))  return false;
  if (dow  && !dow.has(date.getDay()))         return false;
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs || [];
  } catch (e) {
    console.error(`[cron-runner] Failed to load ${JOBS_FILE}:`, e.message);
    return [];
  }
}

function log(name, msg) {
  console.log(`[${new Date().toISOString()}] [${name}] ${msg}`);
}

function postToDiscord(channelId, message) {
  if (!channelId || !fs.existsSync(DISCORD_POST)) return;
  spawn('node', [DISCORD_POST, channelId, message], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  }).unref();
}

// ── Job runner ────────────────────────────────────────────────────────────────

const runningJobs = new Set();

function runJob(job) {
  if (runningJobs.has(job.id)) {
    log(job.name, 'Skipping — already running');
    return;
  }
  runningJobs.add(job.id);
  log(job.name, 'Starting');

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}-${job.id}.log`);
  const out = fs.openSync(logPath, 'a');
  const ts = new Date().toISOString();
  fs.writeSync(out, `\n=== ${ts} — ${job.name} ===\n`);
  const headerEndPos = fs.fstatSync(out).size;

  const model = job.model || CRON_DEFAULT_MODEL;
  log(job.name, `Model: ${model}`);

  const child = spawn(
    CLAUDE_BIN,
    ['--dangerously-skip-permissions', '--model', model, '-p', job.message],
    {
      cwd: WORKSPACE,
      stdio: ['ignore', out, out],
      env: { ...process.env, HOME: process.env.HOME || '/home/node' },
    }
  );

  let timedOut = false;
  const timeoutMs = (job.timeoutSeconds || 300) * 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    log(job.name, `Timed out after ${job.timeoutSeconds || 300}s — killing`);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000);
    if (job.discordChannel) {
      postToDiscord(job.discordChannel, `⏱️ **${job.name}** timed out after ${job.timeoutSeconds || 300}s`);
    }
  }, timeoutMs);

  child.on('close', code => {
    clearTimeout(timer);
    try { fs.closeSync(out); } catch {}
    runningJobs.delete(job.id);
    log(job.name, `Done (exit ${code})`);

    if (job.discordChannel && job.announceResult) {
      const output = fs.readFileSync(logPath, 'utf8').split('\n').slice(-20).join('\n').trim();
      const icon = code === 0 ? '✅' : '❌';
      const preview = output.length > 1800 ? output.slice(-1800) : output;
      postToDiscord(job.discordChannel, `${icon} **${job.name}**\n\`\`\`\n${preview}\n\`\`\``);
    }

    // Alert when a job exits with no output — catches silent failures and
    // PATH-broken outages where claude exits 0 without doing any work.
    if (!timedOut && job.discordChannel && !job.announceResult) {
      try {
        const finalSize = fs.statSync(logPath).size;
        if (finalSize - headerEndPos < 50) {
          postToDiscord(job.discordChannel, `⚠️ **${job.name}** silent exit — no output produced (exit ${code ?? '?'}). Check \`crons/logs/\`.`);
        }
      } catch {}
    }
  });

  child.on('error', err => {
    clearTimeout(timer);
    try { fs.closeSync(out); } catch {}
    runningJobs.delete(job.id);
    log(job.name, `Error: ${err.message}`);
    if (job.discordChannel) {
      postToDiscord(job.discordChannel, `❌ **${job.name}** failed to start: ${err.message}`);
    }
  });
}

// ── Manual trigger support ────────────────────────────────────────────────────
// Drop an empty file at crons/triggers/<jobId>.trigger to fire a job immediately.

function checkTriggers(jobs) {
  if (!fs.existsSync(TRIGGERS_DIR)) return;
  let files;
  try { files = fs.readdirSync(TRIGGERS_DIR); } catch { return; }
  for (const f of files) {
    const jobId = f.replace(/\.trigger$/, '');
    const triggerPath = path.join(TRIGGERS_DIR, f);
    const job = jobs.find(j => j.id === jobId);
    if (job) {
      log(job.name, 'Manual trigger detected');
      try { fs.unlinkSync(triggerPath); } catch {}
      runJob(job);
    } else {
      try { fs.unlinkSync(triggerPath); } catch {} // unknown job, clean up
    }
  }
}

// ── Lock file — only one daemon allowed ──────────────────────────────────────

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      try {
        const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
        if (oldPid && oldPid !== process.pid) {
          process.kill(oldPid, 0); // throws ESRCH if dead
          console.error(`[cron-runner] Already running as PID ${oldPid}. Exiting.`);
          process.exit(0);
        }
      } catch (killErr) {
        if (killErr.code === 'ESRCH') {
          console.log('[cron-runner] Stale lock — taking over.');
          fs.writeFileSync(LOCK_FILE, String(process.pid));
        } else { throw killErr; }
      }
    } else { throw e; }
  }
  process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
  process.on('SIGINT',  () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// ── Main tick loop ─────────────────────────────────────────────────────────────

function tick() {
  const jobs = loadJobs();
  const now  = new Date();
  checkTriggers(jobs);
  for (const job of jobs) {
    if (!job.enabled || !job.schedule) continue;
    const tz     = job.tz || DEFAULT_TZ;
    const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    if (cronMatches(job.schedule, tzDate)) runJob(job);
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────────

async function runOne(jobId) {
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === jobId || j.name === jobId);
  if (!job) {
    console.error(`[cron-runner] Job not found: ${jobId}`);
    console.error(`Available IDs: ${jobs.map(j => j.id).join(', ')}`);
    process.exit(1);
  }
  console.log(`[cron-runner] --run: executing "${job.name}" immediately`);
  runJob(job);
  await new Promise(resolve => {
    const check = setInterval(() => {
      if (!runningJobs.has(job.id)) { clearInterval(check); resolve(); }
    }, 1000);
  });
  process.exit(0);
}

function main() {
  const runIdx = process.argv.indexOf('--run');
  if (runIdx !== -1) {
    const jobId = process.argv[runIdx + 1];
    if (!jobId) { console.error('[cron-runner] --run requires a job ID'); process.exit(1); }
    runOne(jobId);
    return;
  }

  acquireLock();
  console.log(`[cron-runner] Starting. Jobs: ${JOBS_FILE}`);
  console.log(`[cron-runner] Timezone: ${DEFAULT_TZ}`);
  console.log(`[cron-runner] Claude binary: ${CLAUDE_BIN}`);

  if (!fs.existsSync(JOBS_FILE)) {
    console.warn('[cron-runner] No jobs.json found — create crons/jobs.json to add scheduled tasks.');
  }

  // Align to the top of the next minute then tick every 60s
  const msUntilNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    tick();
    setInterval(tick, 60000);
  }, msUntilNextMinute);

  console.log(`[cron-runner] First tick in ${Math.round(msUntilNextMinute / 1000)}s`);
}

main();
