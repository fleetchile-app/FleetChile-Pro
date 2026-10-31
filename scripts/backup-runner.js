#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { fail } = require('../backup-crypto');
const { doctor, reportError } = require('./backup');
function scheduleConfig(env) {
  const seconds = Number(env.BACKUP_INTERVAL_SECONDS || 86400);
  if (env.BACKUP_SCHEDULE_ENABLED !== 'yes' || !Number.isSafeInteger(seconds) || seconds < 3600 || seconds > 604800) throw fail('BACKUP_SCHEDULE_EXPLICIT_ENABLE_INTERVAL_REQUIRED');
  return seconds * 1000;
}
async function main() {
  const command = process.argv[2] || 'doctor';
  if (command === 'doctor') { console.log(JSON.stringify(await doctor())); return; }
  if (command !== 'schedule' || process.argv.length !== 3) throw fail('BACKUP_RUNNER_DOCTOR_OR_SCHEDULE_REQUIRED');
  const interval = scheduleConfig(process.env); await doctor();
  let child, timer, stopped = false;
  const stop = () => { stopped = true; clearTimeout(timer); child?.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const tick = () => {
    if (stopped) return;
    child = spawn(process.execPath, [path.join(__dirname, 'backup.js'), 'create'], { env: process.env, windowsHide: true, stdio: 'inherit' });
    child.once('error', () => console.error('BACKUP_RUNNER_CHILD_FAILED'));
    child.once('close', () => { child = null; if (!stopped) timer = setTimeout(tick, interval); });
  };
  tick(); // Sequential, no overlap; no retention implicitly attached to scheduling.
}
if (require.main === module) main().catch(reportError);
module.exports = { scheduleConfig };
