#!/usr/bin/env node
// APE tenant deploy. Default: dry-run, records calls, creates nothing.
// Live: node deploy.js <tenant-id> --live, only if APE_DEPLOY_LIVE_CONFIRMED=1
// and every required env name below is set. Env VALUES are never logged;
// the bearer token is passed to AWS via a 0600 temp file, then deleted.
// No root, no hardcoded credentials, no hardcoded account or region.
'use strict';
const { execSync } = require('node:child_process');
const { writeFileSync, unlinkSync, chmodSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { tenantPolicy } = require('./policy.js');

const args = process.argv.slice(2);
const tenantId = args.find((a) => !a.startsWith('--'));
const live = args.includes('--live');
const outPath = args.find((a) => a.startsWith('--out='))?.slice(6) || null;
if (!tenantId || !/^[a-z0-9_-]{3,64}$/.test(tenantId)) {
  console.error('usage: deploy.js <tenant-id> [--live] [--out=calls.json]');
  process.exit(2);
}
if (live && process.env.APE_DEPLOY_LIVE_CONFIRMED !== '1') {
  console.error('refusing live deploy: set APE_DEPLOY_LIVE_CONFIRMED=1');
  process.exit(1);
}
const env = (n) => process.env[n];
const required = ['AWS_REGION', 'AWS_ACCOUNT_ID', 'APE_CLUSTER', 'APE_SUBNETS', 'APE_SECURITY_GROUP', 'APE_IMAGE', 'APE_CADDY_IMAGE', 'APE_EXECUTION_ROLE_ARN'];
for (const n of required) if (!env(n)) { console.error(`missing required env name: ${n}`); process.exit(2); }
if (!/^\d{12}$/.test(env('AWS_ACCOUNT_ID'))) { console.error('invalid AWS_ACCOUNT_ID'); process.exit(2); }

const roleName = `ape-tenant-${tenantId}`;
const roleArn = `arn:aws:iam::${env('AWS_ACCOUNT_ID')}:role/${roleName}`;
const secretName = `ape-tenant-${tenantId}/bearer`;
const secretArn = `arn:aws:secretsmanager:${env('AWS_REGION')}:${env('AWS_ACCOUNT_ID')}:secret:${secretName}`;
const logGroup = `/ape/tenants/${tenantId}`;
const calls = [];
const record = (service, action, detail) => calls.push({ service, action, ...detail });

function aws(argv, secretFile) {
  // argv: array of CLI tokens, never containing a secret value.
  if (!live) return { dryRun: true };
  const cmd = ['aws', ...argv].join(' ');
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf8', env: process.env });
}

let tokenFile = null;
let taskArn = null;
const completed = [];
try {
  // 1. IAM role
  record('iam', 'CreateRole', { roleName, trustService: 'ecs-tasks.amazonaws.com' });
  aws(['iam', 'create-role', '--role-name', roleName, '--assume-role-policy-document', JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] })]);
  completed.push('role');
  // 2. Role policy (tenant scope only, from policy.js)
  const policy = tenantPolicy(tenantId, env('AWS_ACCOUNT_ID'), env('AWS_REGION'));
  record('iam', 'PutRolePolicy', { roleName, policyName: 'ape-tenant-scope', policy });
  aws(['iam', 'put-role-policy', '--role-name', roleName, '--policy-name', 'ape-tenant-scope', '--policy-document', JSON.stringify(policy)]);
  completed.push('policy');
  // 3. Secret (token via 0600 temp file in live mode only; redacted in dry-run)
  record('secretsmanager', 'CreateSecret', { secretName, value: '<redacted>' });
  if (live) {
    const token = randomBytes(32).toString('hex');
    tokenFile = join(tmpdir(), `ape-tenant-${tenantId}.json`);
    writeFileSync(tokenFile, JSON.stringify({ bearer_token: token }), { mode: 0o600 });
    aws(['secretsmanager', 'create-secret', '--name', secretName, '--secret-string', `file://${tokenFile}`]);
  }
  completed.push('secret');
  // 4. Log group
  record('logs', 'CreateLogGroup', { logGroupName: logGroup });
  aws(['logs', 'create-log-group', '--log-group-name', logGroup]);
  completed.push('logGroup');
  // 5. Task definition (template substitution, no secrets in the JSON)
  const tpl = readFileSync(join(__dirname, 'task-definition.json'), 'utf8')
    .replaceAll('__TENANT_ID__', tenantId).replaceAll('__APE_IMAGE__', env('APE_IMAGE'))
    .replaceAll('__CADDY_IMAGE__', env('APE_CADDY_IMAGE'))
    .replaceAll('__SECRET_ARN__', secretArn).replaceAll('__LOG_GROUP__', logGroup)
    .replaceAll('__REGION__', env('AWS_REGION')).replaceAll('__TASK_ROLE_ARN__', roleArn)
    .replaceAll('__EXECUTION_ROLE_ARN__', env('APE_EXECUTION_ROLE_ARN'));
  record('ecs', 'RegisterTaskDefinition', { family: `ape-tenant-${tenantId}`, taskRoleArn: roleArn });
  if (live) {
    const f = join(tmpdir(), `ape-taskdef-${tenantId}.json`); writeFileSync(f, tpl, { mode: 0o600 });
    aws(['ecs', 'register-task-definition', '--cli-input-json', `file://${f}`]); unlinkSync(f);
  }
  completed.push('taskDefinition');
  // 6. RunTask (private subnets, no public IP; NAT prerequisite, see README)
  record('ecs', 'RunTask', { cluster: '<from APE_CLUSTER env>', taskDefinition: `ape-tenant-${tenantId}`, taskRoleArn: roleArn, network: 'awsvpc, assignPublicIp=DISABLED' });
  if (live) {
    const out = aws(['ecs', 'run-task', '--cluster', env('APE_CLUSTER'), '--task-definition', `ape-tenant-${tenantId}`, '--launch-type', 'FARGATE', '--network-configuration', `awsvpcConfiguration={subnets=[${env('APE_SUBNETS')}],securityGroups=[${env('APE_SECURITY_GROUP')}],assignPublicIp=DISABLED}`]);
    taskArn = JSON.parse(out).tasks?.[0]?.taskArn || null;
  }
  completed.push('runTask');
} catch (e) {
  console.error(`deploy failed at step ${completed.length + 1}: ${String(e.message || e).slice(0, 300)}`);
  console.error('rollback: run rollback.js with the same tenant id (live mode only reverses live resources; dry-run records the reverse calls)');
  process.exit(1);
} finally {
  if (tokenFile) { try { unlinkSync(tokenFile); } catch {} }
}
const result = { tenantId, live, roleName, roleArn, secretName, logGroup, taskArn, completed, calls };
if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
