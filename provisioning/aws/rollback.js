#!/usr/bin/env node
// Rollback for one tenant deploy, reverse order, once, no loop.
// Default dry-run. Live only with --live and APE_DEPLOY_LIVE_CONFIRMED=1.
// Usage: rollback.js <tenant-id> [--task-arn <arn>] [--live] [--out=file]
'use strict';
const { execSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const tenantId = args.find((a) => !a.startsWith('--'));
const live = args.includes('--live');
const outPath = args.find((a) => a.startsWith('--out='))?.slice(6) || null;
const taskArn = args[args.indexOf('--task-arn') + 1] || null;
if (!tenantId || !/^[a-z0-9_-]{3,64}$/.test(tenantId)) { console.error('usage: rollback.js <tenant-id> [--task-arn <arn>] [--live]'); process.exit(2); }
if (live && process.env.APE_DEPLOY_LIVE_CONFIRMED !== '1') { console.error('refusing live rollback: set APE_DEPLOY_LIVE_CONFIRMED=1'); process.exit(1); }
const calls = [];
function step(label, argv) {
  calls.push(label);
  if (live) execSync(`aws ${argv.join(' ')}`, { stdio: 'pipe', encoding: 'utf8' });
}
const role = `ape-tenant-${tenantId}`;
// Reverse order of deploy.js. StopTask first, role last.
if (taskArn) step({ service: 'ecs', action: 'StopTask', task: taskArn }, ['ecs', 'stop-task', '--cluster', process.env.APE_CLUSTER || '<APE_CLUSTER>', '--task', taskArn]);
step({ service: 'secretsmanager', action: 'DeleteSecret', secret: `${role}/bearer` }, ['secretsmanager', 'delete-secret', '--secret-id', `${role}/bearer`, '--force-delete-without-recovery']);
step({ service: 'logs', action: 'DeleteLogGroup', logGroup: `/ape/tenants/${tenantId}` }, ['logs', 'delete-log-group', '--log-group-name', `/ape/tenants/${tenantId}`]);
step({ service: 'iam', action: 'DeleteRolePolicy', role }, ['iam', 'delete-role-policy', '--role-name', role, '--policy-name', 'ape-tenant-scope']);
step({ service: 'iam', action: 'DeleteRole', role }, ['iam', 'delete-role', '--role-name', role]);
const result = { tenantId, live, calls };
if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
