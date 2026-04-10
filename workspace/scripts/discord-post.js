#!/usr/bin/env node
/**
 * discord-post.js — Post a message to a Discord channel via bot token.
 *
 * Usage (CLI):
 *   node scripts/discord-post.js <channelId> <message>
 *
 * Usage (from another script):
 *   const { postToDiscord } = require('./discord-post');
 *   await postToDiscord('1234567890', 'Hello!');
 *
 * Requires DISCORD_BOT_TOKEN in environment.
 */
'use strict';

const https = require('https');

async function postToDiscord(channelId, message) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN not set');
  if (!channelId) throw new Error('channelId is required');

  const content = message.length > 2000 ? message.slice(0, 1997) + '...' : message;
  const body = JSON.stringify({ content });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'discord.com',
        path: `/api/v10/channels/${channelId}/messages`,
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
          else reject(new Error(`Discord API ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

if (require.main === module) {
  const [, , channelId, ...parts] = process.argv;
  const message = parts.join(' ');
  if (!channelId || !message) {
    console.error('Usage: node discord-post.js <channelId> <message>');
    process.exit(1);
  }
  postToDiscord(channelId, message)
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Failed:', err.message);
      process.exit(1);
    });
}

module.exports = { postToDiscord };
