#!/usr/bin/env node
// APE tenant deploy. Default: dry-run, records calls, creates nothing.
// Live: node deploy.js <tenant-id> --live, only if APE_DEPLOY_LIVE_CONFIRMED=1
// and every required env name below is set. Env VALUES are never logged;
// the Bearer [REDACTED] is passed to AWS via a random 0600 temp file, then
// deleted in a finally block. All AWS calls use execFileSync argv
// arrays — no shell, ever (the old string-joined execSync made env
// values like APE_CLUSTER a command-injection vector in live mode).
//
// Steps: role -> policy -> secret -> log group (+30d retention) ->
// task definition (parsed + placeholder-scanned before registering)
// -> RunTask -> ALB target group + host rule (only when
// APE_ALB_LISTENER_ARN is set; otherwise the deploy RECORDS that
// routing is unconfigured and returns no endpoint — a running task
// nobody can reach is never reported as ready). Re-running adopts
// existing role/secret/log group instead of dying on AlreadyExists.
// On failure, completed steps are rolled back in reverse (live).
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
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
if (!/^[a-z]{2}-[a-z]+-\d$/.test(env('AWS_REGION'))) { console.error('invalid AWS_REGION'); process.exit(2); }
for (const n of ['APE_SUBNETS', 'APE_SECURITY_GROUP', 'APE_CLUSTER']) {
  if (!/^[A-Za-z0-9_,.\-]{1,200}$/.test(env(n))) { console.error(`invalid ${n} format`); process.exit(2); }
}

const roleName = `ape-tenant-${tenantId}`;
const account = env('AWS_ACCOUNT_ID');
const region = env('AWS_REGION');
const roleArn = `arn:aws:iam::${account}:role/${roleName}`;
const secretName = `ape-tenant-${tenantId}/bearer`;
const secretArnBase = `arn:aws:secretsmanager:${region}:${account}:secret:${secretName}`;
const logGroup = `/ape/tenants/${tenantId}`;
const albConfigured = Boolean(env('APE_ALB_LISTENER_ARN'));
if (live && albConfigured && !env('APE_VPC_ID')) {
  console.error('APE_VPC_ID is required when APE_ALB_LISTENER_ARN is set (target group needs a VPC)');
  process.exit(2);
}
const publicDomain = env('APE_PUBLIC_DOMAIN') || '';
const calls = [];
const record = (service, action, detail) => calls.push({ service, action, ...detail });

function aws(argv) {
  if (!live) return { dryRun: true };
  return execFileSync('aws', argv, { stdio: 'pipe', encoding: 'utf8', env: process.env });
}
function awsJson(argv) {
  const out = aws(argv);
  return live ? JSON.parse(out) : { dryRun: true };
}
function isAlreadyExists(e) {
  return /AlreadyExists|EntityAlreadyExists|already exists/i.test(String(e.stderr || e.message || e));
}

const completed = [];
let tmpDir = null;
let taskArn = null;
let targetGroupArn = env('APE_TARGET_GROUP_ARN') || null;
try {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ape-deploy-'));

  record('iam', 'CreateRole', { roleName, trustService: 'ecs-tasks.amazonaws.com' });
  try {
    aws(['iam', 'create-role', '--role-name', roleName, '--assume-role-policy-document',
      // Confused-deputy guard: only this account's ECS may assume it.
      JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': account } } }] }),
      '--tags', `Key=ape:tenant,Value=${tenantId}`]);
  } catch (e) { if (!isAlreadyExists(e)) throw e; record('iam', 'AdoptExistingRole', { roleName }); }
  completed.push('role');

  const policy = tenantPolicy(tenantId, account, region);
  record('iam', 'PutRolePolicy', { roleName, policyName: 'ape-tenant-scope', policy });
  aws(['iam', 'put-role-policy', '--role-name', roleName, '--policy-name', 'ape-tenant-scope', '--policy-document', JSON.stringify(policy)]);
  completed.push('policy');

  record('secretsmanager', 'CreateSecret', { secretName, value: '<redacted>' });
  if (live) {
    const token = randomBytes(32).toString('hex');
    const tokenFile = path.join(tmpDir, 'secret.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ bearer_token: token }), { mode: 0o600 });
    try {
      aws(['secretsmanager', 'create-secret', '--name', secretName, '--secret-string', `file://${tokenFile}`,
        '--tags', `Key=ape:tenant,Value=${tenantId}`]);
    } catch (e) { if (!isAlreadyExists(e)) throw e; record('secretsmanager', 'AdoptExistingSecret', { secretName }); }
  }
  completed.push('secret');

  record('logs', 'CreateLogGroup', { logGroupName: logGroup });
  try {
    aws(['logs', 'create-log-group', '--log-group-name', logGroup,
      '--tags', `ape:tenant=${tenantId}`]);
  } catch (e) { if (!isAlreadyExists(e)) throw e; record('logs', 'AdoptExistingLogGroup', { logGroupName: logGroup }); }
  record('logs', 'PutRetentionPolicy', { logGroupName: logGroup, retentionInDays: 30 });
  aws(['logs', 'put-retention-policy', '--log-group-name', logGroup, '--retention-in-days', '30']);
  completed.push('logGroup');

  // Task definition: substitute, then PARSE and scan for leftover
  // placeholders before registering (a leftover __X__ used to pass).
  const tpl = fs.readFileSync(path.join(__dirname, 'task-definition.json'), 'utf8')
    .replaceAll('__TENANT_ID__', tenantId).replaceAll('__APE_IMAGE__', env('APE_IMAGE'))
    .replaceAll('__CADDY_IMAGE__', env('APE_CADDY_IMAGE'))
    .replaceAll('__SECRET_ARN__', secretArnBase).replaceAll('__LOG_GROUP__', logGroup)
    .replaceAll('__REGION__', region).replaceAll('__TASK_ROLE_ARN__', roleArn)
    .replaceAll('__EXECUTION_ROLE_ARN__', env('APE_EXECUTION_ROLE_ARN'));
  if (/__[A-Z_]+__/.test(tpl)) throw new Error('task definition has unsubstituted placeholders');
  JSON.parse(tpl); // throws on invalid JSON — fail here, not at AWS
  record('ecs', 'RegisterTaskDefinition', { family: `ape-tenant-${tenantId}`, taskRoleArn: roleArn });
  if (live) {
    const f = path.join(tmpDir, 'taskdef.json');
    fs.writeFileSync(f, tpl, { mode: 0o600 });
    aws(['ecs', 'register-task-definition', '--cli-input-json', `file://${f}`]);
  }
  completed.push('taskDefinition');

  record('ecs', 'RunTask', { cluster: '<from APE_CLUSTER env>', taskDefinition: `ape-tenant-${tenantId}`, taskRoleArn: roleArn, network: 'awsvpc, assignPublicIp=DISABLED' });
  if (live) {
    const out = awsJson(['ecs', 'run-task', '--cluster', env('APE_CLUSTER'), '--task-definition', `ape-tenant-${tenantId}`, '--launch-type', 'FARGATE',
      '--network-configuration', `awsvpcConfiguration={subnets=[${env('APE_SUBNETS')}],securityGroups=[${env('APE_SECURITY_GROUP')}],assignPublicIp=DISABLED}`]);
    taskArn = out.tasks?.[0]?.taskArn || null;
  }
  completed.push('runTask');

  // Step 7: routing. Without a listener there is no endpoint, and
  // the result says so instead of fabricating one.
  let endpoint = null;
  if (albConfigured) {
    const tgName = `ape-${tenantId}`.slice(0, 32);
    record('elbv2', 'CreateTargetGroup', { name: tgName, port: 8080, targetType: 'ip' });
    if (live && !targetGroupArn) {
      const tg = awsJson(['elbv2', 'create-target-group', '--name', tgName, '--protocol', 'HTTP', '--port', '8080',
        '--vpc-id', env('APE_VPC_ID') || '', '--target-type', 'ip', '--health-check-path', '/discover',
        '--tags', `Key=ape:tenant,Value=${tenantId}`]);
      targetGroupArn = tg.TargetGroups?.[0]?.TargetGroupArn || null;
    }
    if (targetGroupArn && taskArn) {
      // awsvpc: register the task's ENI private IP on port 8080.
      // Without this the listener forwards to an empty target group
      // while reporting 'routed' (Codex P1). Live calls execute;
      // dry-run records them.
      record('ecs', 'DescribeTasks', { task: '<run-task result>' });
      record('ec2', 'DescribeNetworkInterfaces', { note: 'task ENI -> private IP' });
      record('elbv2', 'RegisterTargets', { targetGroup: '<created>', port: 8080 });
      if (live) {
        const described = awsJson(['ecs', 'describe-tasks', '--cluster', env('APE_CLUSTER'), '--tasks', taskArn]);
        const eniId = described.tasks?.[0]?.attachments
          ?.flatMap((a) => a.details || [])
          .find((d) => d.name === 'networkInterfaceId')?.value;
        if (!eniId) throw new Error('could not resolve task ENI for ALB registration');
        const eni = awsJson(['ec2', 'describe-network-interfaces', '--network-interface-ids', eniId]);
        const ip = eni.NetworkInterfaces?.[0]?.PrivateIpAddress;
        if (!ip) throw new Error('task ENI has no private IP for ALB registration');
        aws(['elbv2', 'register-targets', '--target-group-arn', targetGroupArn,
          '--targets', `Id=${ip},Port=8080`]);
      }
    }
    const host = publicDomain ? `ape-${tenantId}.${publicDomain}` : null;
    record('elbv2', 'CreateRule', { listener: '<from APE_ALB_LISTENER_ARN>', host });
    if (live && targetGroupArn && host) {
      aws(['elbv2', 'create-rule', '--listener-arn', env('APE_ALB_LISTENER_ARN'),
        '--priority', String(100 + (parseInt(tenantId.replace(/\D/g, '').slice(0, 4) || '1', 10) % 40000)),
        '--conditions', `Field=host-header,Values=${host}`,
        '--actions', `Type=forward,TargetGroupArn=${targetGroupArn}`]);
    }
    endpoint = host ? `https://${host}` : null;
    completed.push('albRouting');
  } else {
    record('elbv2', 'RoutingNotConfigured', { note: 'Set APE_ALB_LISTENER_ARN (+ APE_PUBLIC_DOMAIN) to route this tenant. No endpoint is claimed until then.' });
  }

  // Step 8: alarms (only when an SNS topic is configured). A silent
  // dead tenant was the audit's observability gap; these page a human.
  if (env('APE_ALARM_TOPIC_ARN')) {
    record('cloudwatch', 'PutMetricAlarm', { alarm: `ape-${tenantId}-tg-unhealthy` });
    if (live && targetGroupArn) {
      aws(['cloudwatch', 'put-metric-alarm', '--alarm-name', `ape-${tenantId}-tg-unhealthy`,
        '--namespace', 'AWS/ApplicationELB', '--metric-name', 'UnHealthyHostCount',
        '--dimensions', `Name=TargetGroup,Value=${targetGroupArn.split('/').slice(-2).join('/')}`,
        '--statistic', 'Maximum', '--period', '300', '--evaluation-periods', '2',
        '--threshold', '1', '--comparison-operator', 'GreaterThanOrEqualToThreshold',
        '--alarm-actions', env('APE_ALARM_TOPIC_ARN'),
        '--tags', `Key=ape:tenant,Value=${tenantId}`]);
    }
    record('cloudwatch', 'PutMetricAlarm', { alarm: `ape-${tenantId}-log-errors` });
    if (live) {
      // Metric-filter dimensions require values extracted from the
      // log event; an unstructured pattern cannot supply one. Use a
      // per-tenant metric NAME instead (no dimensions anywhere).
      try {
        aws(['logs', 'put-metric-filter', '--log-group-name', logGroup,
          '--filter-name', 'ape-errors', '--filter-pattern', '?ERROR ?error ?FATAL',
          '--metric-transformations', `metricName=ApeErrors-${tenantId},metricNamespace=APE/Tenants,metricValue=1`]);
      } catch { /* metric filter is best-effort beside the alarm */ }
      aws(['cloudwatch', 'put-metric-alarm', '--alarm-name', `ape-${tenantId}-log-errors`,
        '--namespace', 'APE/Tenants', '--metric-name', `ApeErrors-${tenantId}`,
        '--statistic', 'Sum', '--period', '300', '--evaluation-periods', '1',
        '--threshold', '5', '--comparison-operator', 'GreaterThanOrEqualToThreshold',
        '--alarm-actions', env('APE_ALARM_TOPIC_ARN'),
        '--tags', `Key=ape:tenant,Value=${tenantId}`]);
    }
    completed.push('alarms');
  } else {
    record('cloudwatch', 'AlarmsNotConfigured', { note: 'Set APE_ALARM_TOPIC_ARN (SNS) to page on tenant failure.' });
  }

  const result = { tenantId, live, roleName, roleArn, secretName, logGroup, taskArn, targetGroupArn, endpoint, endpointStatus: endpoint ? 'routed' : 'unrouted', completed, calls };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(`deploy failed at step ${completed.length + 1}: ${String(e.message || e).slice(0, 300)}`);
  if (live && completed.length) {
    console.error('auto-rollback of completed steps: ' + completed.slice().reverse().join(', '));
    // Best-effort reverse cleanup; full/audited teardown is rollback.js.
    const undo = {
      alarms: () => {
        try { aws(['cloudwatch', 'delete-alarms', '--alarm-names', `ape-${tenantId}-tg-unhealthy`, `ape-${tenantId}-log-errors`]); } catch {}
      },
      albRouting: () => {
        // Routing must not outlive the task it points at.
        try {
          const rules = awsJson(['elbv2', 'describe-rules', '--listener-arn', env('APE_ALB_LISTENER_ARN')]);
          for (const r of rules.Rules || []) {
            const acts = JSON.stringify(r.Actions || []);
            if (targetGroupArn && acts.includes(targetGroupArn)) {
              aws(['elbv2', 'delete-rule', '--rule-arn', r.RuleArn]);
            }
          }
        } catch {}
        if (targetGroupArn) { try { aws(['elbv2', 'delete-target-group', '--target-group-arn', targetGroupArn]); } catch {} }
      },
      runTask: () => {
        if (taskArn) { try { aws(['ecs', 'stop-task', '--cluster', env('APE_CLUSTER'), '--task', taskArn]); } catch {} }
      },
      logGroup: () => {}, // logs retained for audit, never deleted here
      taskDefinition: () => { try { aws(['ecs', 'deregister-task-definition', '--task-definition', `ape-tenant-${tenantId}`]); } catch {} },
      secret: () => { try { aws(['secretsmanager', 'delete-secret', '--secret-id', secretName, '--recovery-window-in-days', '7']); } catch {} },
      policy: () => { try { aws(['iam', 'delete-role-policy', '--role-name', roleName, '--policy-name', 'ape-tenant-scope']); } catch {} },
      role: () => { try { aws(['iam', 'delete-role', '--role-name', roleName]); } catch {} },
    };
    for (const s of completed.slice().reverse()) { if (undo[s]) undo[s](); }
  }
  process.exit(1);
} finally {
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
}
