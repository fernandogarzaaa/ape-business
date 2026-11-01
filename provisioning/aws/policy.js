// Tenant IAM policy, pure function. One tenant, nothing else.
// Usage: node -e "console.log(JSON.stringify(require('./policy.js')('tn_x','123','us-east-1'),null,2))"
function tenantPolicy(tenantId, accountId, region) {
  if (!/^[a-z0-9_-]{3,64}$/.test(tenantId)) throw new Error('invalid tenant id');
  if (!/^\d{12}$/.test(accountId)) throw new Error('invalid AWS account id');
  // Region was interpolated unvalidated: '*' produced an any-region
  // secret ARN (probed). Fail here, at policy build, not live at AWS.
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Error('invalid AWS region');
  const bucket = 'arn:aws:s3:::ape-tenants';
  const s3 = `arn:aws:s3:::ape-tenants/${tenantId}/*`;
  const secret = `arn:aws:secretsmanager:${region}:${accountId}:secret:ape-tenant-${tenantId}/bearer-*`;
  const logs = `arn:aws:logs:${region}:${accountId}:log-group:/ape/tenants/${tenantId}:*`;
  return {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: [s3] },
      // ListBucket on the bucket, conditioned to this tenant's prefix
      // only — without it every APE list call fails live (dry-run
      // could never catch that; the policy shape hid it).
      {
        Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [bucket],
        Condition: { StringLike: { 's3:prefix': [`${tenantId}/*`] } },
      },
      { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: [secret] },
      { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: [logs] },
    ],
  };
}
module.exports = { tenantPolicy };
