// Tenant IAM policy, pure function. One tenant, nothing else.
// Usage: node -e "console.log(JSON.stringify(require('./policy.js')('tn_x','123','us-east-1'),null,2))"
function tenantPolicy(tenantId, accountId, region) {
  if (!/^[a-z0-9_-]{3,64}$/.test(tenantId)) throw new Error('invalid tenant id');
  if (!/^\d{12}$/.test(accountId)) throw new Error('invalid AWS account id');
  const s3 = `arn:aws:s3:::ape-tenants/${tenantId}/*`;
  const secret = `arn:aws:secretsmanager:${region}:${accountId}:secret:ape-tenant-${tenantId}/bearer-*`;
  const logs = `arn:aws:logs:${region}:${accountId}:log-group:/ape/tenants/${tenantId}:*`;
  return {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: [s3] },
      { Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: [secret] },
      { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: [logs] },
    ],
  };
}
module.exports = { tenantPolicy };
