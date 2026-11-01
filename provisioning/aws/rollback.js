#!/usr/bin/env node
// Rollback for one tenant deploy, reverse order, once, no loop.
// Default dry-run. Live only with --live and APE_DEPLOY_LIVE_CONFIRMED=1.
// Usage: rollback.js <tenant-id> [--task-arn <arn>] [--live] [--out=file]
//
// Audit trail survives rollback: the log group is RETAINED (export
// before teardown per SECURITY.md), the secret deletes WITH a 7-day
// recovery window (never --force-delete-without-recovery), and each
// step tolerates NotFound so one missing resource cannot strand the
// rest half-deleted. All AWS calls are execFileSync argv — no shell.
'use strict';

const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');

const args = process.argv.slice(2);
const tenantId = args.find((a) => !a.startsWith('--'));
const live = args.includes('--live');
const outPath = args.find((a) => a.startsWith('--out='))?.slice(6) || null;
// Only read the value when the flag is present: indexOf is -1 when
// omitted, and args[0] (the tenant id) is not a task ARN (Codex P1).
const taskArnIdx = args.indexOf('--task-arn');
const taskArnArg = taskArnIdx >= 0 ? (args[taskArnIdx + 1] || null) : null;
if (taskArnArg && !/^arn:aws:ecs:[a-z0-9-]+:\d{12}:task\/[A-Za-z0-9_\-/]+$/.test(taskArnArg)) {
  console.error('invalid --task-arn format');
  process.exit(2);
}
if (!tenantId || !/^[a-z0-9_-]{3,64}$/.test(tenantId)) { console.error('usage: rollback.js <tenant-id> [--task-arn <arn>] [--live]'); process.exit(2); }
if (live && process.env.APE_DEPLOY_LIVE_CONFIRMED !== '1') { console.error('refusing live rollback: set APE_DEPLOY_LIVE_CONFIRMED=1'); process.exit(1); }

const calls = [];
const failures = [];
function step(label, argv) {
  calls.push(label);
  if (!live) return;
  try {
    execFileSync('aws', argv, { stdio: 'pipe', encoding: 'utf8', env: process.env });
  } catch (e) {
    const msg = String(e.stderr || e.message || e);
    if (/NotFound|NoSuchEntity|does not exist/i.test(msg)) {
      calls.push({ service: label.service, action: label.action + 'SkippedNotFound' });
      return;
    }
    failures.push(label.action + ': ' + msg.slice(0, 200));
  }
}

const role = `ape-tenant-${tenantId}`;
const cluster = process.env.APE_CLUSTER || '<APE_CLUSTER>';
let taskArn = taskArnArg;
if (live && !taskArn && process.env.APE_CLUSTER) {
  try {
    const out = execFileSync('aws', ['ecs', 'list-tasks', '--cluster', cluster,
      '--family', `ape-tenant-${tenantId}`, '--desired-status', 'RUNNING'],
    { stdio: 'pipe', encoding: 'utf8', env: process.env });
    taskArn = JSON.parse(out).taskArns?.[0] || null;
  } catch { /* recorded below as unresolved */ }
}
// Reverse order of deploy.js. StopTask first, role last.
if (taskArn) {
  step({ service: 'ecs', action: 'StopTask', task: taskArn },
    ['ecs', 'stop-task', '--cluster', cluster, '--task', taskArn]);
} else {
  calls.push({ service: 'ecs', action: 'StopTaskSkippedNoTaskArn', note: 'No task ARN resolvable; task may still run. Resolve and stop it before deleting its role.' });
}
step({ service: 'ecs', action: 'DeregisterTaskDefinition', family: `ape-tenant-${tenantId}` },
  ['ecs', 'deregister-task-definition', '--task-definition', `ape-tenant-${tenantId}`]);
step({ service: 'secretsmanager', action: 'DeleteSecretWithRecovery', secret: `${role}/bearer` },
  ['secretsmanager', 'delete-secret', '--secret-id', `${role}/bearer`, '--recovery-window-in-days', '7']);
calls.push({ service: 'logs', action: 'RetainLogGroup', logGroup: `/ape/tenants/${tenantId}`, note: 'Audit trail retained per SECURITY.md. Export, then delete manually after the retention window.' });
step({ service: 'iam', action: 'DeleteRolePolicy', role },
  ['iam', 'delete-role-policy', '--role-name', role, '--policy-name', 'ape-tenant-scope']);
step({ service: 'iam', action: 'DeleteRole', role },
  ['iam', 'delete-role', '--role-name', role]);

const result = { tenantId, live, calls, failures };
if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(failures.length ? 1 : 0);
