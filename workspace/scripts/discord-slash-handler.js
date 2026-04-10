#!/usr/bin/env node
/**
 * discord-slash-handler.js — Handles Discord slash command interactions.
 *
 * Runs as a persistent process in its own tmux window.
 * Listens for slash commands via Discord gateway and executes them.
 *
 * Supported commands:
 *   /status        — health check (disk, cron runner)
 *   /model [name]  — show or switch Claude model
 *   /compact       — compact session context
 *   /cron          — list / run / logs for scheduled jobs
 *   /ask <message> — send any message to Claude via claude -p
 *
 * Usage:
 *   node scripts/discord-slash-handler.js
 *
 * Requires DISCORD_BOT_TOKEN in environment.
 */
'use strict';

const { Client, GatewayIntentBits } = require('discord.js');
const { spawn, execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace';
const JOBS_FILE = path.join(WORKSPACE, 'crons', 'jobs.json');
const LOG_DIR   = path.join(WORKSPACE, 'crons', 'logs');
const DISCORD_POST = path.join(WORKSPACE, 'scripts', 'discord-post.js');
const MODEL_STATE_FILE = path.join(WORKSPACE, 'data', 'current-model.json');

const MODEL_ALIASES = {
  opus:   'claude-opus-4-5',
  sonnet: 'claude-sonnet-4-5',
  haiku:  'claude-haiku-4-5',
};

// ── Auth / env ────────────────────────────────────────────────────────────────

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnv(path.join(WORKSPACE, '.env'));
loadEnv(path.join(process.env.HOME || '/home/node', '.claude', 'channels', 'discord', '.env'));

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error('[slash-handler] ❌ DISCORD_BOT_TOKEN not set');
  process.exit(1);
}

// ── Model state ───────────────────────────────────────────────────────────────

function readCurrentModel() {
  try {
    return JSON.parse(fs.readFileSync(MODEL_STATE_FILE, 'utf8')).model || 'sonnet';
  } catch {
    return 'sonnet';
  }
}

function writeCurrentModel(alias) {
  fs.mkdirSync(path.dirname(MODEL_STATE_FILE), { recursive: true });
  fs.writeFileSync(
    MODEL_STATE_FILE,
    JSON.stringify({ model: alias, updatedAt: new Date().toISOString() })
  );
}

function restartClaudeSession() {
  try {
    execFileSync('tmux', ['send-keys', '-t', 'claude:0', 'C-c', ''], { timeout: 3000 });
    console.log('[slash-handler] tmux C-c sent to claude:0');
    return true;
  } catch {
    // fallback
  }
  try {
    execFileSync('sh', ['-c', 'pkill -f "claude --dangerously-skip-permissions"'], { timeout: 3000 });
    console.log('[slash-handler] pkill sent');
    return true;
  } catch (e) {
    console.error('[slash-handler] Could not restart Claude session:', e.message);
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJobs() {
  try { return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs || []; }
  catch { return []; }
}

function truncate(str, max = 1900) {
  return str.length <= max ? str : str.slice(0, max - 3) + '...';
}

function runClaude(prompt, timeoutMs = 120_000) {
  return new Promise(resolve => {
    const model = readCurrentModel();
    const chunks = [];
    const child = spawn(
      'claude',
      ['--dangerously-skip-permissions', '--model', model, '-p', prompt],
      {
        cwd: WORKSPACE,
        env: { ...process.env, HOME: process.env.HOME || '/home/node' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => chunks.push(d));
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve('[timed out]'); }, timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8').trim()); });
    child.on('error', e => { clearTimeout(timer); resolve(`[error: ${e.message}]`); });
  });
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleStatus(interaction) {
  await interaction.deferReply();
  const result = await runClaude(
    'Run a quick health check and return a short status report.\n' +
    'Check: disk space (df -h /), cron-runner process (ps aux | grep cron-runner | grep -v grep), uptime.\n' +
    'Format the reply as a short bullet list with emoji. Keep it under 10 lines.'
  );
  await interaction.editReply(truncate(result || '❌ No output'));
}

async function handleModel(interaction) {
  await interaction.deferReply();
  const raw = interaction.options.getString('model');

  if (!raw) {
    const current = readCurrentModel();
    const full = MODEL_ALIASES[current] || current;
    await interaction.editReply(`🤖 Current model: **${current}** (\`${full}\`)`);
    return;
  }

  const alias = raw.toLowerCase();
  if (!MODEL_ALIASES[alias]) {
    await interaction.editReply(`❌ Unknown model: \`${alias}\`. Choose: \`opus\`, \`sonnet\`, or \`haiku\``);
    return;
  }

  try { writeCurrentModel(alias); }
  catch (err) { await interaction.editReply(`❌ Failed to save: ${err.message}`); return; }

  await interaction.editReply(
    `🔄 Switching to **${alias}** (\`${MODEL_ALIASES[alias]}\`) — restarting session (~10s)...`
  );
  restartClaudeSession();
}

async function handleCompact(interaction) {
  await interaction.deferReply();
  const result = await runClaude('/compact');
  await interaction.editReply(truncate(result || '✅ Context compacted'));
}

async function handleCron(interaction) {
  const action = interaction.options.getString('action');
  const jobArg = interaction.options.getString('job') || '';
  await interaction.deferReply();

  if (action === 'list') {
    const enabled = loadJobs().filter(j => j.enabled);
    const lines = enabled.map(j => `• **${j.name}** — \`${j.schedule}\``);
    await interaction.editReply(
      truncate(enabled.length
        ? `⏰ **${enabled.length} enabled job(s)**\n${lines.join('\n')}`
        : '📭 No enabled jobs found in crons/jobs.json')
    );
    return;
  }

  const job = loadJobs().find(
    j => j.name.toLowerCase().includes(jobArg.toLowerCase()) || j.id === jobArg
  );

  if (action === 'logs') {
    if (!job) { await interaction.editReply(`❌ Job not found: \`${jobArg}\``); return; }
    // Find the most recent log file for this job
    const logs = fs.existsSync(LOG_DIR)
      ? fs.readdirSync(LOG_DIR).filter(f => f.includes(job.id)).sort().reverse()
      : [];
    if (!logs.length) { await interaction.editReply(`📭 No logs yet for **${job.name}**`); return; }
    const lines = fs.readFileSync(path.join(LOG_DIR, logs[0]), 'utf8').split('\n').slice(-30).join('\n');
    await interaction.editReply(truncate(`📋 **${job.name}**\n\`\`\`\n${lines}\n\`\`\``));
    return;
  }

  if (action === 'run') {
    if (!job) { await interaction.editReply(`❌ Job not found: \`${jobArg}\``); return; }
    await interaction.editReply(`▶️ Running **${job.name}**... (timeout: ${job.timeoutSeconds || 300}s)`);
    const result = await runClaude(job.message, (job.timeoutSeconds || 300) * 1000);
    if (interaction.channel) {
      await interaction.channel.send(truncate(`✅ **${job.name}** complete:\n${result || '(no output)'}`));
    }
  }
}

async function handleAsk(interaction) {
  const message = interaction.options.getString('message');
  await interaction.deferReply();
  const result = await runClaude(message, 180_000);
  await interaction.editReply(truncate(result || '❌ No output'));
}

// ── Discord client ────────────────────────────────────────────────────────────

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on('ready', () => {
  console.log(`[slash-handler] ✅ Logged in as ${client.user.tag}`);
  console.log('[slash-handler] Listening for slash commands...');
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  console.log(`[slash-handler] /${commandName} from ${interaction.user.tag}`);

  try {
    switch (commandName) {
      case 'status':  await handleStatus(interaction);  break;
      case 'model':   await handleModel(interaction);   break;
      case 'compact': await handleCompact(interaction); break;
      case 'cron':    await handleCron(interaction);    break;
      case 'ask':     await handleAsk(interaction);     break;
      default:
        await interaction.reply({ content: `Unknown command: \`/${commandName}\``, ephemeral: true });
    }
  } catch (err) {
    console.error(`[slash-handler] Error in /${commandName}:`, err);
    const msg = `❌ Error: ${err.message}`;
    try {
      if (interaction.deferred) await interaction.editReply(msg);
      else await interaction.reply({ content: msg, ephemeral: true });
    } catch { /* already replied */ }
  }
});

client.on('error', err => console.error('[slash-handler] Client error:', err.message));

console.log('[slash-handler] Starting...');
client.login(TOKEN).catch(err => {
  console.error('[slash-handler] Login failed:', err.message);
  process.exit(1);
});
