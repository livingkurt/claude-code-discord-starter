#!/usr/bin/env node
/**
 * discord-slash-register.js — Register slash commands with Discord.
 *
 * Run this once (or after changing commands):
 *   node scripts/discord-slash-register.js
 *
 * Requires DISCORD_BOT_TOKEN and DISCORD_APP_ID in environment or .env.
 *
 * Commands registered:
 *   /status        — quick health check
 *   /model [name]  — show or switch Claude model (opus / sonnet / haiku)
 *   /compact       — compact Claude's context window
 *   /cron          — list / run / view logs for scheduled jobs
 *   /ask <message> — send any message to your bot via claude -p
 */
'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Load .env if present
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const TOKEN  = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.DISCORD_APP_ID;

if (!TOKEN || !APP_ID) {
  console.error('❌ Set DISCORD_BOT_TOKEN and DISCORD_APP_ID in your .env file');
  process.exit(1);
}

const commands = [
  {
    name: 'status',
    description: 'Quick health check — disk, cron runner, uptime',
  },
  {
    name: 'model',
    description: 'Show or switch the Claude model',
    options: [
      {
        name: 'model',
        description: 'Model to switch to (leave blank to show current)',
        type: 3, // STRING
        required: false,
        choices: [
          { name: 'opus   (claude-opus-4-5)',   value: 'opus' },
          { name: 'sonnet (claude-sonnet-4-5)', value: 'sonnet' },
          { name: 'haiku  (claude-haiku-4-5)',  value: 'haiku' },
        ],
      },
    ],
  },
  {
    name: 'compact',
    description: 'Compact the Claude session context window',
  },
  {
    name: 'cron',
    description: 'Manage scheduled cron jobs',
    options: [
      {
        name: 'action',
        description: 'What to do',
        type: 3, // STRING
        required: true,
        choices: [
          { name: 'list',  value: 'list'  },
          { name: 'run',   value: 'run'   },
          { name: 'logs',  value: 'logs'  },
        ],
      },
      {
        name: 'job',
        description: 'Job name or ID (required for run and logs)',
        type: 3,
        required: false,
      },
    ],
  },
  {
    name: 'ask',
    description: 'Send any message to your bot via claude -p',
    options: [
      {
        name: 'message',
        description: 'What to ask',
        type: 3,
        required: true,
      },
    ],
  },
];

const body = JSON.stringify(commands);

const req = https.request(
  {
    hostname: 'discord.com',
    path: `/api/v10/applications/${APP_ID}/commands`,
    method: 'PUT',
    headers: {
      Authorization: `Bot ${TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  },
  res => {
    let data = '';
    res.on('data', chunk => (data += chunk));
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const registered = JSON.parse(data);
        console.log(`✅ Registered ${registered.length} global slash command(s):`);
        registered.forEach(c => console.log(`   /${c.name} — ${c.description}`));
        console.log('\nNote: Global commands take up to 1 hour to appear in Discord.');
        console.log('For instant testing, add a DISCORD_GUILD_ID to your .env and update the API path to:');
        console.log(`  /api/v10/applications/${APP_ID}/guilds/YOUR_GUILD_ID/commands`);
      } else {
        console.error(`❌ Failed (${res.statusCode}):`, data);
      }
    });
  }
);

req.on('error', err => console.error('Request failed:', err.message));
req.write(body);
req.end();
