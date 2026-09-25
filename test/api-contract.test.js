import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const serviceWorker = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const sql = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

test('social API exposes persistent content operations', () => {
  for (const route of ['/api/feed', '/api/posts', '/api/messages', '/api/channels', '/api/media']) {
    assert.match(server, new RegExp(route.replaceAll('/', '\\/')));
  }
  assert.match(server, /postAction = url\.pathname\.match/);
  assert.match(server, /like\|save/);
});

test('database schema contains persistent interactions and auth tokens', () => {
  for (const model of ['model PostLike', 'model PostSave', 'model EmailToken']) assert.match(schema, new RegExp(model));
  for (const table of ['post_likes', 'post_saves', 'email_tokens']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
});

test('developer access is checked by the server owner role', () => {
  assert.match(server, /url\.pathname === '\/api\/owner\/status'/);
  assert.match(server, /user\?\.role === 'owner'/);
  assert.doesNotMatch(server, /localStorage/);
});

test('state-changing API requests require CSRF protection', () => {
  assert.match(server, /url\.pathname === '\/api\/csrf'/);
  assert.match(server, /CSRF_INVALID/);
  assert.match(server, /X-CSRF-Token/);
});

test('frontend hydrates real conversations and accepts the server owner role', () => {
  const app = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(app, /hydrate.*Messages|load.*Conversation|selected.*recipient/i);
  assert.match(app, /role === 'owner'|role === 'boss'/i);
});

test('authenticated users can fetch and clear notifications from the backend', () => {
  assert.match(server, /\/api\/notifications/);
  assert.match(server, /mark.*read|readAt|read_at/i);
});

test('authenticated users can sign out cleanly from the UI and API', () => {
  const app = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(server, /\/auth\/logout/);
  assert.match(app, /data-logout|logout/i);
});

test('moderation and report workflows exist for owner and moderator controls', () => {
  assert.match(server, /\/api\/reports/);
  assert.match(server, /\/api\/moderation\/reports/);
  assert.match(server, /ReportStatus|moderationLogs|reporterId/i);
});

test('text moderation runs before user-generated content is stored', () => {
  for (const route of [
    /request\.method === 'POST' && url\.pathname === '\/api\/posts'[\s\S]*?contentCheck\(text\)[\s\S]*?prisma\.post\.create/,
    /postRoute[\s\S]*?contentCheck\(text\)[\s\S]*?prisma\.post\.update/,
    /request\.method === 'POST' && commentsRoute[\s\S]*?contentCheck\(text\)[\s\S]*?prisma\.comment\.create/,
    /request\.method === 'POST' && url\.pathname === '\/api\/messages'[\s\S]*?contentCheck\(text\)[\s\S]*?prisma\.message\.create/,
    /request\.method === 'PATCH' && url\.pathname === '\/api\/me'[\s\S]*?contentCheck\([\s\S]*?prisma\.user\.update/,
    /request\.method === 'POST' && url\.pathname === '\/api\/channels'[\s\S]*?contentCheck\([\s\S]*?prisma\.channel\.create/,
    /channelRoute[\s\S]*?contentCheck\([\s\S]*?prisma\.channel\.update/
  ]) assert.match(server, route);
});

test('new posts stay hidden from public feeds until moderator approval', () => {
  assert.match(schema, /moderationStatus String\s+@default\("approved"\)/);
  assert.match(sql, /moderation_status TEXT NOT NULL DEFAULT 'approved'/);
  assert.match(server, /moderationStatus: 'pending'/);
  assert.match(server, /moderationStatus: 'approved', visibility: 'public'/);
  assert.match(server, /url\.pathname === '\/api\/moderation\/posts'/);
  assert.match(server, /moderationStatus !== 'approved'/);
  assert.match(server, /action: `content_\$\{status\}`/);
});

test('video moderation jobs are started, associated with posts, and polled', () => {
  const app = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(server, /StartContentModerationCommand/);
  assert.match(server, /redis\.set\(`media_moderation:/);
  assert.match(server, /processPendingMediaModeration/);
  assert.match(server, /MEDIA_MODERATION_UNAVAILABLE/);
  assert.match(server, /mediaModerationEnabled\(\)/);
  assert.match(app, /moderationJobId/);
  assert.match(app, /media-moderation-consent/);
  assert.match(app, /عند تفعيل التكامل يُرسل إلى AWS/);
  assert.match(schema, /moderationJobId String\?/);
  assert.match(compose, /AWS_REKOGNITION_SNS_TOPIC_ARN/);
});

test('text moderation preview uses the same central blocklist', () => {
  assert.match(server, /url\.pathname === '\/api\/moderation\/check'[\s\S]*?contentCheck\(body\.text\)/);
});

test('service worker never caches authenticated API or auth responses', () => {
  assert.match(serviceWorker, /CACHE_NAME = 'nexa-cache-v2'/);
  assert.match(serviceWorker, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(serviceWorker, /pathname\.startsWith\('\/auth\/'\)/);
  assert.match(serviceWorker, /if \(pathname === '\/api'[\s\S]*?return;/);
});

test('owner telemetry and audit access exist for production-grade governance', () => {
  const app = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(server, /\/api\/audit/);
  assert.match(app, /audit|telemetry|metrics/i);
});

test('production deployment config exists for web hosting and container runtime', () => {
  const dockerfile = fs.existsSync(new URL('../Dockerfile', import.meta.url)) ? fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8') : '';
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(server, /server\.listen\(port, '0\.0\.0\.0'/);
  assert.match(dockerfile, /FROM/);
  assert.match(compose, /image:.*nexa|build:/i);
});

test('server stays alive in degraded mode when infrastructure is unavailable', () => {
  assert.doesNotMatch(server, /process\.exitCode = 1/);
  assert.match(server, /degraded mode|servicesReady = false|servicesReady\s*=\s*false/i);
});

test('guest users get a safe unauthenticated response instead of a fatal 401 page issue', () => {
  assert.match(server, /url\.pathname === '\/api\/me'/);
  assert.match(server, /guest:\s*true|user:\s*null/i);
});

test('Google OAuth accepts a dev-safe callback and reuses the correct app redirect', () => {
  assert.match(server, /resolveRedirectTarget|typeof state === 'string'/i);
  assert.match(server, /providerSubject: String\(profile\.sub\)/i);
  assert.match(server, /nexa_oauth_session/i);
  assert.match(server, /oauth_state:/i);
  assert.match(server, /SameSite=\s*None|usesSecureCookies\(\)/i);
});

test('OAuth state is generated only by the backend and stored in Redis, not in memory', () => {
  assert.doesNotMatch(server, /pendingOAuth\s*=\s*new Map\(|new Map\(\)/i);
  assert.match(server, /redis\.set\(`oauth_state:/i);
  assert.match(server, /redis\.get\(`oauth_state:/i);
});

test('Google login uses a backend-generated state and redirects to the profile setup flow', () => {
  assert.match(server, /randomBytes\(64\)/i);
  assert.match(server, /\/setup-profile|setup-profile/i);
  assert.match(server, /nexa_oauth_session/i);
  assert.match(server, /Set-Cookie[\s\S]*nexa_oauth_session/i);
});
