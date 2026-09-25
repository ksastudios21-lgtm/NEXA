import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectVideoModeration } from '../server/media-moderation.js';

test('completed video scans with no labels can be automatically approved', async () => {
  const client = { send: async () => ({ JobStatus: 'SUCCEEDED', ModerationLabels: [] }) };
  assert.deepEqual(await inspectVideoModeration(client, 'job-safe'), { status: 'approved', labels: [] });
});

test('flagged videos remain in the human review queue', async () => {
  const label = { Name: 'Explicit Nudity', Confidence: 99 };
  const client = { send: async () => ({ JobStatus: 'SUCCEEDED', ModerationLabels: [{ ModerationLabel: label }] }) };
  assert.deepEqual(await inspectVideoModeration(client, 'job-flagged'), { status: 'review', labels: [label] });
});

test('in-progress video scans stay hidden until AWS completes them', async () => {
  const client = { send: async () => ({ JobStatus: 'IN_PROGRESS' }) };
  assert.deepEqual(await inspectVideoModeration(client, 'job-running'), { status: 'pending', labels: [] });
});

test('completed video scans collect moderation labels across result pages', async () => {
  const client = {
    send: async command => command.input.NextToken
      ? { JobStatus: 'SUCCEEDED', ModerationLabels: [{ ModerationLabel: { Name: 'Violence', Confidence: 88 } }] }
      : { JobStatus: 'SUCCEEDED', ModerationLabels: [], NextToken: 'page-2' }
  };
  assert.deepEqual(await inspectVideoModeration(client, 'job-paged'), {
    status: 'review',
    labels: [{ Name: 'Violence', Confidence: 88 }]
  });
});