#!/usr/bin/env node
/**
 * Switches backend/.env from the local Mailpit catcher to real Gmail delivery,
 * then proves it works by sending you a test message.
 *
 * Run it from your own terminal:   node scripts/use-gmail.mjs
 *
 * The App Password is read with echo off and written straight to .env — it is
 * never printed, never logged, and never passed as a shell argument (so it
 * cannot land in your shell history).
 */
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import nodemailer from 'nodemailer';

const ENV_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), '.env');

function ask(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (hidden) {
      // Swallow the echo so the password never appears on screen.
      const onData = (char) => {
        if (['\n', '\r', ''].includes(String(char))) process.stdin.removeListener('data', onData);
        else process.stdout.write('[2K[200D' + question + '*'.repeat(rl.line.length));
      };
      process.stdin.on('data', onData);
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

/** Replaces a KEY=... line, or appends it when the key is absent. */
function setVar(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}

const [, , ...args] = process.argv;

if (args[0] === '--mailpit') {
  let env = readFileSync(ENV_PATH, 'utf8');
  for (const [k, v] of [
    ['SMTP_HOST', '127.0.0.1'],
    ['SMTP_PORT', '1025'],
    ['SMTP_SECURE', 'false'],
    ['SMTP_USER', ''],
    ['SMTP_PASS', ''],
    ['SMTP_FROM', '"TimeFlow <no-reply@timeflow.dev>"'],
  ]) env = setVar(env, k, v);
  writeFileSync(ENV_PATH, env);
  console.log('\n✓ Switched back to Mailpit (http://localhost:8025).');
  console.log('  Restart the worker:  launchctl kickstart -k gui/$(id -u)/local.timeflow.worker\n');
  process.exit(0);
}

console.log('\n  Gmail delivery setup');
console.log('  ────────────────────');
console.log('  Need an App Password? https://myaccount.google.com/apppasswords');
console.log('  (it only appears there once 2-Step Verification is on)\n');

const user = (await ask('  Gmail address: ')).toLowerCase();
if (!/^[^\s@]+@gmail\.com$/.test(user)) {
  console.error('\n  ✗ That does not look like a Gmail address.\n');
  process.exit(1);
}

const raw = await ask('  App Password: ', { hidden: true });
const pass = raw.replace(/\s+/g, ''); // Google shows it in four groups of four.
if (pass.length !== 16) {
  console.error(`\n  ✗ Expected 16 characters, got ${pass.length}. Copy the whole App Password.\n`);
  process.exit(1);
}

process.stdout.write('\n  Checking the credentials with Gmail… ');
const transport = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: { user, pass },
});

try {
  await transport.verify();
  console.log('ok');
} catch (err) {
  console.error('failed\n');
  const msg = String(err?.message ?? err);
  if (/535|BadCredentials|Username and Password not accepted/i.test(msg)) {
    console.error('  ✗ Gmail rejected the credentials.');
    console.error('    • Use an App Password, not your normal Google password.');
    console.error('    • Make sure 2-Step Verification is on for this account.');
    console.error('    • Check the address matches the account the App Password came from.\n');
  } else {
    console.error(`  ✗ Could not reach Gmail: ${msg}\n`);
  }
  console.error('  Nothing was written to .env.\n');
  process.exit(1);
}

// Only touch .env once Gmail has accepted the credentials.
if (existsSync(ENV_PATH)) copyFileSync(ENV_PATH, `${ENV_PATH}.bak`);
let env = readFileSync(ENV_PATH, 'utf8');
for (const [k, v] of [
  ['SMTP_HOST', 'smtp.gmail.com'],
  ['SMTP_PORT', '587'],
  ['SMTP_SECURE', 'false'],
  ['SMTP_USER', user],
  ['SMTP_PASS', pass],
  // Gmail rewrites any other sender, so From must be this same address.
  ['SMTP_FROM', `"TimeFlow <${user}>"`],
]) env = setVar(env, k, v);
writeFileSync(ENV_PATH, env);
console.log(`  ✓ Wrote .env (previous copy saved as .env.bak)`);

process.stdout.write('  Sending you a test message… ');
try {
  await transport.sendMail({
    from: `TimeFlow <${user}>`,
    to: user,
    subject: 'TimeFlow: Gmail delivery is working',
    text: 'If you are reading this in your inbox, TimeFlow can now send real email.',
    html: '<div style="font-family:system-ui,sans-serif;padding:24px"><h2 style="margin:0 0 8px">Gmail delivery is working</h2><p style="color:#475569">TimeFlow can now send real email from this account.</p></div>',
  });
  console.log('sent');
} catch (err) {
  console.error(`failed: ${String(err?.message ?? err)}\n`);
  process.exit(1);
}

console.log('\n  Check your inbox (look in Spam too, the first one often lands there).');
console.log('\n  Last step — restart the worker so it picks up the new settings:');
console.log('    launchctl kickstart -k gui/$(id -u)/local.timeflow.worker\n');
console.log('  To go back to Mailpit later:  node scripts/use-gmail.mjs --mailpit\n');
