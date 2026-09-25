import test from 'node:test';
import assert from 'node:assert/strict';
import { contentCheck } from '../server/moderation.js';

test('moderation rejects configured abusive terms as separate words', () => {
  assert.equal(contentCheck('هذا shit كلام'), 'CONTENT_REJECTED');
  assert.equal(contentCheck('نص عادي ومحترم'), null);
  assert.equal(contentCheck('الزبدة في الموضوع'), null);
});

test('moderation normalizes Arabic marks and punctuation obfuscation', () => {
  assert.equal(contentCheck('كـسـم'), 'CONTENT_REJECTED');
  assert.equal(contentCheck('f.u.c.k'), 'CONTENT_REJECTED');
});

test('moderation accepts additional terms from server configuration', () => {
  const previous = process.env.CONTENT_BLOCKLIST;
  process.env.CONTENT_BLOCKLIST = 'ممنوع';
  try {
    assert.equal(contentCheck('هذا ممنوع هنا'), 'CONTENT_REJECTED');
  } finally {
    if (previous === undefined) delete process.env.CONTENT_BLOCKLIST;
    else process.env.CONTENT_BLOCKLIST = previous;
  }
});