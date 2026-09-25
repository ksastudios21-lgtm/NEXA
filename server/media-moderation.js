import { GetContentModerationCommand } from '@aws-sdk/client-rekognition';

export async function inspectVideoModeration(client, jobId) {
  const labels = [];
  let nextToken;
  let jobStatus = 'IN_PROGRESS';

  do {
    const result = await client.send(new GetContentModerationCommand({ JobId: jobId, MaxResults: 1000, NextToken: nextToken }));
    jobStatus = result.JobStatus || 'IN_PROGRESS';
    labels.push(...(result.ModerationLabels || []).map(item => item.ModerationLabel).filter(Boolean));
    nextToken = result.NextToken;
  } while (nextToken && jobStatus === 'SUCCEEDED');

  if (jobStatus === 'SUCCEEDED') return { status: labels.length ? 'review' : 'approved', labels };
  if (jobStatus === 'FAILED') return { status: 'review', labels: [{ Name: 'Automated scan failed' }] };
  return { status: 'pending', labels: [] };
}