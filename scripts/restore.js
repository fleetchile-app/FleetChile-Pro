#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { keyFromFile, fail } = require('../backup-crypto');
const { secrets, reportError } = require('./backup');
const { restoreDrill } = require('../backup-restore');
async function main(args = process.argv.slice(2), initial = process.env) {
  if (args.length !== 1 || !path.isAbsolute(args[0])) throw fail('RESTORE_ABSOLUTE_BUNDLE_DIRECTORY_REQUIRED');
  const env = await secrets(initial), key = await keyFromFile(env.BACKUP_KEY_FILE);
  try { return await restoreDrill({ dir: args[0], key, env }); } finally { key.fill(0); }
}
if (require.main === module) main().then(r => console.log(JSON.stringify(r))).catch(reportError);
module.exports = { main };
