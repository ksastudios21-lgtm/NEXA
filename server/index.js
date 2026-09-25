import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import { StartContentModerationCommand } from '@aws-sdk/client-rekognition';
import { connectServices, disconnectServices, prisma, redis, s3, moderationS3, rekognition, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from './services.js';
import { sendSecurityMail, smtpEnabled } from './mailer.js';
import { contentCheck } from './moderation.js';
import { inspectVideoModeration } from './media-moderation.js';

const port = Number(process.env.PORT || 4000);
const appOrigin = process.env.APP_ORIGIN || process.env.FRONTEND_ORIGIN || 'https://automatic-happiness-9655vrgx6jw9hpp9p-5173.app.github.dev';
const sessionSecret = process.env.SESSION_SECRET;
const jwtSecret = process.env.JWT_SECRET || sessionSecret;
let servicesReady = false;
const startedAt = Date.now();
let requestCount = 0;
let errorCount = 0;

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': appOrigin, 'Access-Control-Allow-Credentials': 'true' });
  response.end(JSON.stringify(body));
}

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

function allowedOrigin(origin) {
  if (!origin) return true;
  return origin === appOrigin || (process.env.NODE_ENV !== 'production' && origin === 'http://localhost:5173');
}

async function rateLimit(request, pathname) {
  if (!servicesReady) return true;
  const ip = request.headers['x-forwarded-for']?.split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
  const group = pathname.startsWith('/auth') ? 'auth' : 'api';
  const limit = group === 'auth' ? 30 : 180;
  const key = `ratelimit:${group}:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    return count <= limit;
  } catch {
    return true;
  }
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(cookie => {
    const separator = cookie.indexOf('=');
    return [cookie.slice(0, separator).trim(), decodeURIComponent(cookie.slice(separator + 1).trim())];
  }));
}

function sign(value) {
  return createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

async function createSession(user) {
  const accessToken = jwt.sign({ sub: user.id, type: 'access' }, jwtSecret, { expiresIn: '15m' });
  const refreshToken = randomBytes(48).toString('base64url');
  await redis.set(`session:${accessToken}`, JSON.stringify(user), 'EX', 15 * 60);
  await redis.set(`refresh:${hashToken(refreshToken)}`, user.id, 'EX', 7 * 24 * 60 * 60);
  await prisma.session.create({ data: { userId: user.id, refreshTokenHash: hashToken(refreshToken), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } });
  return { accessToken, refreshToken };
}

function hashToken(value) {
  return createHash('sha256').update(value).digest('hex');
}

function usesSecureCookies() {
  return /^https:\/\//i.test(process.env.APP_ORIGIN || appOrigin || '') || process.env.NODE_ENV === 'production';
}

function cookieAttributes({ maxAge = 0, secure = usesSecureCookies(), sameSite = secure ? 'None' : 'Lax', path = '/', domain = process.env.COOKIE_DOMAIN || '', httpOnly = true } = {}) {
  const parts = [];
  if (httpOnly) parts.push('HttpOnly');
  parts.push(`SameSite=${sameSite}`);
  parts.push(`Path=${path}`);
  if (maxAge >= 0) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

function cookieString(name, value, options = {}) {
  const serialized = `${name}=${encodeURIComponent(value)}; ${cookieAttributes(options)}`;
  return serialized.trim();
}

function buildSessionUser(user) {
  const derivedRole = user.role === 'owner' ? 'owner' : 'user';
  return {
    ...user,
    status: user.status || 'active',
    role: derivedRole,
    tier: user.verification === 'gold' ? 'gold' : user.verification === 'yellow' ? 'yellow' : 'normal',
    profileSetup: Boolean(user.displayName && user.username) && user.emailVerified !== false,
    provider: user.identities?.[0]?.provider || 'local'
  };
}

const credentialsSchema = z.object({ email: z.string().email().max(254), password: z.string().min(8).max(128) });

function publicUser(user) {
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

async function clearRedisPattern(pattern) {
  const keys = await redis.keys(pattern);
  if (!keys.length) return 0;
  await redis.del(...keys);
  return keys.length;
}

async function createEmailToken(userId, type, minutes = 30) {
  const token = randomBytes(32).toString('base64url');
  await prisma.emailToken.create({ data: { userId, tokenHash: hashToken(token), type, expiresAt: new Date(Date.now() + minutes * 60 * 1000) } });
  return token;
}

async function readSession(request) {
  if (!jwtSecret) return null;
  const token = parseCookies(request).nexa_session || '';
  if (!token) return null;
  try {
    jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    const user = await redis.get(`session:${token}`);
    return user ? JSON.parse(user) : null;
  } catch {
    return null;
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) return null;
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; }
}

async function readRawBody(request, limit = 100 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requireText(value, max = 5000) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function extractPostMetadata(text) {
  const source = String(text || '');
  return {
    mentions: [...new Set([...source.matchAll(/@([A-Za-z0-9_]{3,20})/g)].map(match => match[1]))].slice(0, 20),
    hashtags: [...new Set([...source.matchAll(/#([\p{L}\p{N}_]{2,40})/gu)].map(match => match[1]))].slice(0, 30)
  };
}

function publicProfile(user) {
  if (!user) return null;
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

async function recordLogin(userId, request, success) {
  if (!userId || !servicesReady) return;
  await prisma.loginHistory.create({ data: {
    userId,
    ip: request.headers['x-forwarded-for']?.split(',')[0].trim() || request.socket.remoteAddress || '',
    userAgent: String(request.headers['user-agent'] || '').slice(0, 500),
    success
  } });
}

async function registerDevice(userId, request) {
  if (!userId || !servicesReady) return;
  const fingerprint = hashToken(`${request.headers['user-agent'] || ''}|${request.headers['accept-language'] || ''}|${request.socket.remoteAddress || ''}`);
  await prisma.device.upsert({
    where: { fingerprint },
    update: { userId, lastSeenAt: new Date(), name: String(request.headers['user-agent'] || 'Unknown device').slice(0, 120) },
    create: { userId, fingerprint, name: String(request.headers['user-agent'] || 'Unknown device').slice(0, 120) }
  });
}

async function authenticatedUser(request) {
  if (!servicesReady) return null;
  const sessionUser = await readSession(request);
  if (!sessionUser?.id) return null;
  return prisma.user.findUnique({ where: { id: sessionUser.id } });
}

function publicPost(post, userId) {
  const { moderationJobId, moderationS3Key, moderationLabels, ...safePost } = post;
  return {
    ...safePost,
    likeCount: post._count?.likes || 0,
    commentCount: post._count?.comments || 0,
    liked: Boolean(userId && post.likes?.some(like => like.userId === userId)),
    saved: Boolean(userId && post.saves?.some(save => save.userId === userId)),
    likes: undefined,
    saves: undefined,
    _count: undefined
  };
}

async function pushNotification(userId, type, payload = {}) {
  if (!userId) return null;
  const notification = await prisma.notification.create({ data: { userId, type, payload } });
  broadcastEvent(userId, { type: 'notification', notification });
  return notification;
}

const liveClients = Object.create(null);

function broadcastEvent(userId, payload) {
  const clients = liveClients[userId] || new Set();
  for (const client of clients) if (client.readyState === 1) client.send(JSON.stringify(payload));
}

function parseMultipart(contentType, buffer) {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) return null;
  const parts = buffer.toString('binary').split(`--${boundary}`).slice(1, -1);
  const result = { fields: {}, file: null };
  for (const part of parts) {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = part.slice(0, separator);
    const payload = part.slice(separator + 4).replace(/\r\n$/, '');
    const disposition = headers.match(/name="([^"]+)"/i)?.[1];
    if (!disposition) continue;
    const filename = headers.match(/filename="([^"]*)"/i)?.[1];
    if (filename) {
      const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
      result.file = { filename, contentType: contentTypeMatch?.[1] || 'application/octet-stream', buffer: Buffer.from(payload, 'binary') };
    } else result.fields[disposition] = Buffer.from(payload, 'binary').toString('utf8');
  }
  return result;
}

function oauthEnabled() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function mediaModerationEnabled() {
  return Boolean(process.env.AWS_S3_BUCKET && process.env.AWS_REKOGNITION_SNS_TOPIC_ARN && process.env.AWS_REKOGNITION_ROLE_ARN);
}

function resolveRedirectTarget(request) {
  const candidates = [process.env.APP_ORIGIN, request.headers.origin, request.headers.referer, appOrigin, 'http://localhost:5173'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      return url.origin || candidate;
    } catch {
      if (/^https?:\/\//.test(candidate)) return candidate;
    }
  }
  return appOrigin;
}

async function setSession(response, user) {
  const safeUser = buildSessionUser(user);
  const { accessToken, refreshToken } = await createSession(safeUser);
  const secure = usesSecureCookies();
  const security = { secure, sameSite: secure ? 'None' : 'Lax', httpOnly: true, domain: process.env.COOKIE_DOMAIN || undefined };
  response.setHeader('Set-Cookie', [
    cookieString('nexa_session', accessToken, { ...security, maxAge: 900, path: '/' }),
    cookieString('nexa_refresh', refreshToken, { ...security, sameSite: 'None', maxAge: 604800, path: '/auth' }),
    cookieString('nexa_oauth_session', '', { ...security, maxAge: 0, path: '/' })
  ]);
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  securityHeaders(response);

  if (!allowedOrigin(request.headers.origin)) return json(response, 403, { error: 'ORIGIN_NOT_ALLOWED' });
  if (!await rateLimit(request, url.pathname)) return json(response, 429, { error: 'RATE_LIMITED' });

  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Origin': appOrigin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token' });
    return response.end();
  }

  if (request.method === 'GET' && url.pathname === '/api/csrf') {
    const token = randomBytes(32).toString('base64url');
    response.setHeader('Set-Cookie', `nexa_csrf=${token}; SameSite=Lax; Path=/; Max-Age=3600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    return json(response, 200, { token });
  }

  if (['POST', 'PATCH', 'DELETE'].includes(request.method) && url.pathname.startsWith('/api/')) {
    const csrfCookie = parseCookies(request).nexa_csrf || '';
    const csrfHeader = request.headers['x-csrf-token'] || '';
    if (!csrfCookie || !csrfHeader || csrfCookie.length !== csrfHeader.length || !timingSafeEqual(Buffer.from(csrfCookie), Buffer.from(csrfHeader))) return json(response, 403, { error: 'CSRF_INVALID' });
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    return json(response, servicesReady ? 200 : 503, { ok: servicesReady, service: 'nexa-api', oauth: oauthEnabled(), appOrigin, redirectUri: process.env.GOOGLE_REDIRECT_URI || null, storage: servicesReady ? 'postgres-redis-minio' : 'offline', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), requestCount, errorCount, mode: servicesReady ? 'live' : 'degraded' });
  }

  if (!servicesReady && url.pathname.startsWith('/api/') && url.pathname !== '/api/health' && url.pathname !== '/api/csrf') {
    return json(response, 503, { error: 'SERVICES_UNAVAILABLE', mode: 'degraded' });
  }

  if (request.method === 'GET' && url.pathname === '/api/me') {
    const user = await readSession(request);
    if (!user) return json(response, 200, { user: null, guest: true });
    return json(response, 200, { user });
  }

  if (request.method === 'GET' && url.pathname === '/api/owner/status') {
    const user = await authenticatedUser(request);
    return json(response, 200, { owner: user?.role === 'owner', role: user?.role || null });
  }

  if (request.method === 'POST' && url.pathname === '/api/owner/claim') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    if (user.role === 'owner') return json(response, 200, { owner: true, claimed: false });
    const claim = await redis.set('nexa:developer:first-owner', user.id, 'NX');
    if (claim !== 'OK') return json(response, 403, { error: 'DEVELOPER_AREA_LOCKED' });
    const owner = await prisma.user.findFirst({ where: { role: 'owner' }, select: { id: true } });
    if (owner && owner.id !== user.id) {
      await redis.del('nexa:developer:first-owner');
      return json(response, 403, { error: 'DEVELOPER_AREA_LOCKED' });
    }
    const updated = await prisma.user.update({ where: { id: user.id }, data: { role: 'owner', verification: 'gold', tier: 'gold' } });
    return json(response, 200, { owner: true, claimed: true, user: publicUser(updated) });
  }

  if (request.method === 'PATCH' && url.pathname === '/api/me') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const body = await readBody(request);
    const parsed = z.object({
      displayName: z.string().trim().min(2).max(30),
      username: z.string().regex(/^[A-Za-z0-9_]+$/).min(3).max(20),
      bio: z.string().trim().max(280).optional(),
      avatarUrl: z.string().url().max(2048).nullable().optional(),
      bannerUrl: z.string().url().max(2048).nullable().optional(),
      location: z.string().trim().max(120).optional(),
      website: z.string().url().max(2048).or(z.literal('')).optional()
    }).safeParse(body);
    if (!parsed.success) return json(response, 400, { error: 'INVALID_PROFILE' });
    if (contentCheck(`${parsed.data.displayName} ${parsed.data.bio || ''}`)) return json(response, 422, { error: 'CONTENT_REJECTED' });
    const duplicate = await prisma.user.findFirst({ where: { username: parsed.data.username, NOT: { id: user.id } } });
    if (duplicate) return json(response, 409, { error: 'USERNAME_IN_USE' });
    const updated = await prisma.user.update({ where: { id: user.id }, data: parsed.data });
    return json(response, 200, { user: publicUser(updated) });
  }

  if (request.method === 'PATCH' && url.pathname === '/api/me/settings') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const body = await readBody(request);
    const parsed = z.object({
      privacy: z.record(z.string(), z.boolean()).optional(),
      notificationsEnabled: z.boolean().optional(),
      language: z.enum(['ar', 'en']).optional(),
      theme: z.enum(['dark', 'light', 'system']).optional()
    }).safeParse(body);
    if (!parsed.success) return json(response, 400, { error: 'INVALID_SETTINGS' });
    const updated = await prisma.user.update({ where: { id: user.id }, data: parsed.data });
    return json(response, 200, { settings: { privacy: updated.privacy, notificationsEnabled: updated.notificationsEnabled, language: updated.language, theme: updated.theme } });
  }

  if (request.method === 'GET' && url.pathname === '/api/me/security') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const [devices, loginHistory, sessions] = await Promise.all([
      prisma.device.findMany({ where: { userId: user.id }, orderBy: { lastSeenAt: 'desc' }, take: 20 }),
      prisma.loginHistory.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, ip: true, userAgent: true, success: true, createdAt: true } }),
      prisma.session.findMany({ where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, expiresAt: true } })
    ]);
    return json(response, 200, { mfaEnabled: user.mfaEnabled, devices, loginHistory, sessions });
  }

  if (request.method === 'GET' && url.pathname === '/api/search') {
    const query = requireText(url.searchParams.get('q'), 80);
    if (!query) return json(response, 200, { users: [], posts: [], channels: [], hashtags: [] });
    const [users, posts, channels] = await Promise.all([
      prisma.user.findMany({ where: { OR: [{ username: { contains: query, mode: 'insensitive' } }, { displayName: { contains: query, mode: 'insensitive' } }] }, take: 20, select: { id: true, username: true, displayName: true, avatarUrl: true, verification: true } }),
      prisma.post.findMany({ where: { deletedAt: null, moderationStatus: 'approved', OR: [{ body: { contains: query, mode: 'insensitive' } }, { hashtags: { array_contains: query } }] }, take: 20, orderBy: { createdAt: 'desc' }, include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true } }, _count: { select: { likes: true, comments: true } } } }),
      prisma.channel.findMany({ where: { OR: [{ name: { contains: query, mode: 'insensitive' } }, { description: { contains: query, mode: 'insensitive' } }] }, take: 20, select: { id: true, name: true, description: true, visibility: true } })
    ]);
    return json(response, 200, { users, posts: posts.map(post => publicPost(post)), channels, hashtags: posts.flatMap(post => Array.isArray(post.hashtags) ? post.hashtags : []).filter(tag => String(tag).toLowerCase().includes(query.toLowerCase())).slice(0, 30) });
  }

  if (request.method === 'GET' && url.pathname === '/api/explore') {
    const posts = await prisma.post.findMany({ where: { deletedAt: null, moderationStatus: 'approved', visibility: 'public' }, orderBy: [{ boostScore: 'desc' }, { createdAt: 'desc' }], take: 50, include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true, verification: true } }, _count: { select: { likes: true, comments: true } } } });
    const tags = Object.create(null);
    posts.forEach(post => (Array.isArray(post.hashtags) ? post.hashtags : []).forEach(tag => { tags[tag] = (tags[tag] || 0) + 1; }));
    const popularCreators = posts.filter((post, index, list) => list.findIndex(item => item.author.id === post.author.id) === index).map(post => post.author).slice(0, 10);
    const popularTags = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([tag, count]) => ({ tag, count }));
    return json(response, 200, { trending: posts.slice(0, 20).map(post => publicPost(post)), popularCreators, popularTags });
  }

  if (request.method === 'GET' && url.pathname === '/api/feed') {
    const user = await authenticatedUser(request);
    const posts = await prisma.post.findMany({
      where: { deletedAt: null, OR: [{ moderationStatus: 'approved', visibility: 'public' }, ...(user ? [{ authorId: user.id }, { moderationStatus: 'approved', visibility: 'followers', author: { followers: { some: { followerId: user.id } } } }] : [])] },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true, verification: true } }, likes: user ? { where: { userId: user.id }, select: { userId: true } } : false, saves: user ? { where: { userId: user.id }, select: { userId: true } } : false, _count: { select: { likes: true, comments: true } } }
    });
    return json(response, 200, { posts: posts.map(post => publicPost(post, user?.id)) });
  }

  if (request.method === 'POST' && url.pathname === '/api/posts') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const body = await readBody(request);
    const text = requireText(body?.body);
    const mediaUrl = typeof body?.mediaUrl === 'string' ? body.mediaUrl.slice(0, 2048) : null;
    const visibility = ['public', 'followers', 'private'].includes(body?.visibility) ? body.visibility : 'public';
    if (!text && !mediaUrl) return json(response, 400, { error: 'POST_CONTENT_REQUIRED' });
    if (contentCheck(text)) return json(response, 422, { error: 'CONTENT_REJECTED' });
    let moderationJobId = null;
    let moderationS3Key = null;
    if (typeof body?.moderationJobId === 'string') {
      const pendingUploadRaw = await redis.get(`media_moderation:${body.moderationJobId}`);
      let pendingUpload = null;
      try { pendingUpload = pendingUploadRaw ? JSON.parse(pendingUploadRaw) : null; } catch { pendingUpload = null; }
      if (!pendingUpload || pendingUpload.userId !== user.id || pendingUpload.mediaUrl !== mediaUrl) return json(response, 403, { error: 'MEDIA_SCAN_INVALID' });
      moderationJobId = body.moderationJobId;
      moderationS3Key = pendingUpload.moderationS3Key;
    }
    const post = await prisma.post.create({ data: { authorId: user.id, body: text || '', mediaUrl, visibility, moderationStatus: 'pending', moderationJobId, moderationS3Key }, include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true, verification: true } }, _count: { select: { likes: true, comments: true } } } });
    if (moderationJobId) await redis.del(`media_moderation:${moderationJobId}`);
    return json(response, 201, { post: publicPost(post, user.id) });
  }

  const postAction = url.pathname.match(/^\/api\/posts\/([^/]+)\/(like|save)$/);
  if (request.method === 'POST' && postAction) {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const postId = postAction[1];
    const relation = postAction[2] === 'like' ? prisma.postLike : prisma.postSave;
    const where = { postId_userId: { postId, userId: user.id } };
    const existing = await relation.findUnique({ where });
    if (existing) await relation.delete({ where });
    else {
      await relation.create({ data: { postId, userId: user.id } });
      if (postAction[2] === 'like') {
        const post = await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true, author: { select: { username: true } } } });
        if (post && post.authorId !== user.id) await pushNotification(post.authorId, 'like', { actorId: user.id, actorName: user.username || user.displayName, postId, message: `${user.username || user.displayName} أعجب بمنشورك` });
      }
    }
    return json(response, 200, { active: !existing });
  }

  const postRoute = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
  if ((request.method === 'PATCH' || request.method === 'DELETE') && postRoute) {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const post = await prisma.post.findUnique({ where: { id: postRoute[1] }, select: { authorId: true } });
    if (!post) return json(response, 404, { error: 'POST_NOT_FOUND' });
    if (post.authorId !== user.id && user.role !== 'owner' && user.role !== 'moderator') return json(response, 403, { error: 'FORBIDDEN' });
    if (request.method === 'DELETE') {
      await prisma.post.update({ where: { id: postRoute[1] }, data: { deletedAt: new Date() } });
      return json(response, 200, { ok: true });
    }
    const body = await readBody(request);
    const text = requireText(body?.body);
    if (!text) return json(response, 400, { error: 'POST_CONTENT_REQUIRED' });
    if (contentCheck(text)) return json(response, 422, { error: 'CONTENT_REJECTED' });
    const updated = await prisma.post.update({ where: { id: postRoute[1] }, data: { body: text, moderationStatus: 'pending', moderationJobId: null } });
    return json(response, 200, { post: updated });
  }

  const commentsRoute = url.pathname.match(/^\/api\/posts\/([^/]+)\/comments$/);
  if (request.method === 'GET' && commentsRoute) {
    const comments = await prisma.comment.findMany({ where: { postId: commentsRoute[1], deletedAt: null }, orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true } } } });
    return json(response, 200, { comments });
  }
  if (request.method === 'POST' && commentsRoute) {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const body = await readBody(request);
    const text = requireText(body?.body, 1000);
    if (!text) return json(response, 400, { error: 'COMMENT_REQUIRED' });
    if (contentCheck(text)) return json(response, 422, { error: 'CONTENT_REJECTED' });
    const comment = await prisma.comment.create({ data: { postId: commentsRoute[1], authorId: user.id, body: text }, include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true } } } });
    const post = await prisma.post.findUnique({ where: { id: commentsRoute[1] }, select: { authorId: true } });
    if (post && post.authorId !== user.id) await pushNotification(post.authorId, 'comment', { actorId: user.id, actorName: user.username || user.displayName, postId: commentsRoute[1], commentId: comment.id, message: `${user.username || user.displayName} علق على منشورك` });
    return json(response, 201, { comment });
  }

  const followRoute = url.pathname.match(/^\/api\/users\/([^/]+)\/follow$/);
  if (request.method === 'POST' && followRoute) {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const followedId = followRoute[1];
    if (followedId === user.id) return json(response, 400, { error: 'CANNOT_FOLLOW_SELF' });
    const followed = await prisma.user.findUnique({ where: { id: followedId }, select: { id: true, username: true, displayName: true } });
    if (!followed) return json(response, 404, { error: 'USER_NOT_FOUND' });
    const where = { followerId_followedId: { followerId: user.id, followedId } };
    const existing = await prisma.follow.findUnique({ where });
    if (existing) await prisma.follow.delete({ where });
    else {
      await prisma.follow.create({ data: { followerId: user.id, followedId } });
      await pushNotification(followedId, 'follow', { actorId: user.id, actorName: user.username || user.displayName, message: `${user.username || user.displayName} بدأ متابعتك` });
    }
    return json(response, 200, { following: !existing });
  }

  if (request.method === 'POST' && url.pathname === '/api/reports') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const body = await readBody(request);
    const targetType = ['post', 'comment', 'user'].includes(body?.targetType) ? body.targetType : null;
    const targetId = typeof body?.targetId === 'string' ? body.targetId : null;
    const reason = requireText(body?.reason, 500);
    if (!targetType || !targetId || !reason) return json(response, 400, { error: 'INVALID_REPORT' });
    const exists = targetType === 'post' ? await prisma.post.findUnique({ where: { id: targetId }, select: { id: true } }) : targetType === 'comment' ? await prisma.comment.findUnique({ where: { id: targetId }, select: { id: true } }) : await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!exists) return json(response, 404, { error: 'TARGET_NOT_FOUND' });
    const report = await prisma.report.create({ data: { reporterId: user.id, targetType, targetId, reason }, include: { reporter: { select: { id: true, username: true, displayName: true } } } });
    return json(response, 201, { report });
  }

  if (request.method === 'GET' && url.pathname === '/api/moderation/reports') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    if (user.role !== 'owner' && user.role !== 'moderator') return json(response, 403, { error: 'FORBIDDEN' });
    const reports = await prisma.report.findMany({ orderBy: { createdAt: 'desc' }, include: { reporter: { select: { id: true, username: true, displayName: true } } } });
    return json(response, 200, { reports });
  }

  if (request.method === 'GET' && url.pathname === '/api/moderation/posts') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    if (user.role !== 'owner' && user.role !== 'moderator') return json(response, 403, { error: 'FORBIDDEN' });
    const posts = await prisma.post.findMany({
      where: { moderationStatus: 'pending', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 50,
      include: { author: { select: { id: true, username: true, displayName: true } } }
    });
    return json(response, 200, { posts });
  }

  const moderationPostRoute = url.pathname.match(/^\/api\/moderation\/posts\/([^/]+)$/);
  if (request.method === 'PATCH' && moderationPostRoute) {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    if (user.role !== 'owner' && user.role !== 'moderator') return json(response, 403, { error: 'FORBIDDEN' });
    const body = await readBody(request);
    const status = ['approved', 'rejected'].includes(body?.status) ? body.status : null;
    if (!status) return json(response, 400, { error: 'INVALID_STATUS' });
    const post = await prisma.post.findUnique({ where: { id: moderationPostRoute[1] }, select: { id: true, moderationStatus: true, moderationS3Key: true } });
    if (!post) return json(response, 404, { error: 'POST_NOT_FOUND' });
    const updated = await prisma.post.update({ where: { id: post.id }, data: { moderationStatus: status, moderationJobId: null, moderationS3Key: null } });
    if (post.moderationS3Key && process.env.AWS_S3_BUCKET) moderationS3.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: post.moderationS3Key })).catch(() => {});
    await prisma.moderationLog.create({ data: { moderatorId: user.id, targetType: 'post', targetId: post.id, action: `content_${status}`, reason: requireText(body?.reason, 500) || 'moderation_queue' } });
    return json(response, 200, { post: updated });
  }

  const moderationReportRoute = url.pathname.match(/^\/api\/moderation\/reports\/([^/]+)$/);
  if ((request.method === 'PATCH' || request.method === 'DELETE') && moderationReportRoute) {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    if (user.role !== 'owner' && user.role !== 'moderator') return json(response, 403, { error: 'FORBIDDEN' });
    const report = await prisma.report.findUnique({ where: { id: moderationReportRoute[1] } });
    if (!report) return json(response, 404, { error: 'REPORT_NOT_FOUND' });
    if (request.method === 'DELETE') {
      await prisma.report.delete({ where: { id: moderationReportRoute[1] } });
      return json(response, 200, { ok: true });
    }
    const body = await readBody(request);
    const nextStatus = ['open', 'reviewing', 'resolved', 'dismissed'].includes(body?.status) ? body.status : null;
    if (!nextStatus) return json(response, 400, { error: 'INVALID_STATUS' });
    const updated = await prisma.report.update({ where: { id: moderationReportRoute[1] }, data: { status: nextStatus } });
    await prisma.moderationLog.create({ data: { moderatorId: user.id, targetType: updated.targetType, targetId: updated.targetId, action: 'report_status_update', reason: `status:${updated.status}` } });
    return json(response, 200, { report: updated });
  }

  if (request.method === 'GET' && url.pathname === '/api/audit') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    if (user.role !== 'owner' && user.role !== 'moderator') return json(response, 403, { error: 'FORBIDDEN' });
    const [logs, metrics] = await Promise.all([
      prisma.moderationLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20, include: { moderator: { select: { id: true, username: true, displayName: true } } } }),
      prisma.$transaction([
        prisma.user.count(),
        prisma.post.count({ where: { deletedAt: null } }),
        prisma.report.count(),
        prisma.session.count({ where: { revokedAt: null } })
      ])
    ]);
    return json(response, 200, {
      logs: logs.map(log => ({ id: log.id, action: log.action, reason: log.reason, targetType: log.targetType, targetId: log.targetId, createdAt: log.createdAt, moderator: log.moderator ? { id: log.moderator.id, username: log.moderator.username, displayName: log.moderator.displayName } : null })),
      metrics: { users: metrics[0], posts: metrics[1], reports: metrics[2], activeSessions: metrics[3] }
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/notifications') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const notifications = await prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 20 });
    return json(response, 200, {
      notifications: notifications.map(notification => ({
        id: notification.id,
        type: notification.type,
        payload: notification.payload,
        readAt: notification.readAt,
        createdAt: notification.createdAt
      })),
      unreadCount: notifications.filter(notification => !notification.readAt).length
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/notifications/read') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const body = await readBody(request);
    const ids = Array.isArray(body?.ids) ? body.ids.filter(item => typeof item === 'string') : [];
    if (ids.length) await prisma.notification.updateMany({ where: { id: { in: ids }, userId: user.id }, data: { readAt: new Date() } });
    else await prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    return json(response, 200, { ok: true });
  }

  if (request.method === 'GET' && url.pathname === '/api/channels') {
    const channels = await prisma.channel.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { owner: { select: { id: true, username: true, displayName: true } }, _count: { select: { messages: true } } } });
    return json(response, 200, { channels });
  }
  if (request.method === 'POST' && url.pathname === '/api/channels') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const body = await readBody(request);
    const name = requireText(body?.name, 80);
    if (!name) return json(response, 400, { error: 'CHANNEL_NAME_REQUIRED' });
    if (contentCheck(`${name} ${body?.description || ''}`)) return json(response, 422, { error: 'CONTENT_REJECTED' });
    const channel = await prisma.channel.create({ data: { ownerId: user.id, name, description: requireText(body?.description, 500) || '', visibility: body?.visibility === 'private' ? 'private' : 'public' } });
    return json(response, 201, { channel });
  }

  const channelRoute = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
  if ((request.method === 'PATCH' || request.method === 'DELETE') && channelRoute) {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const channel = await prisma.channel.findUnique({ where: { id: channelRoute[1] }, select: { ownerId: true } });
    if (!channel) return json(response, 404, { error: 'CHANNEL_NOT_FOUND' });
    if (channel.ownerId !== user.id && user.role !== 'owner') return json(response, 403, { error: 'FORBIDDEN' });
    if (request.method === 'DELETE') {
      await prisma.channel.delete({ where: { id: channelRoute[1] } });
      return json(response, 200, { ok: true });
    }
    const body = await readBody(request);
    const name = requireText(body?.name, 80);
    if (!name) return json(response, 400, { error: 'CHANNEL_NAME_REQUIRED' });
    if (contentCheck(`${name} ${body?.description || ''}`)) return json(response, 422, { error: 'CONTENT_REJECTED' });
    const updated = await prisma.channel.update({ where: { id: channelRoute[1] }, data: { name, description: requireText(body?.description, 500) || '' } });
    return json(response, 200, { channel: updated });
  }

  if (request.method === 'GET' && url.pathname === '/api/messages') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const recipientId = url.searchParams.get('recipientId');
    const channelId = url.searchParams.get('channelId');
    if (!recipientId && !channelId) return json(response, 400, { error: 'MESSAGE_TARGET_REQUIRED' });
    const messages = await prisma.message.findMany({ where: recipientId ? { OR: [{ senderId: user.id, recipientId }, { senderId: recipientId, recipientId: user.id }] } : { channelId }, orderBy: { createdAt: 'asc' }, take: 100, include: { sender: { select: { id: true, username: true, displayName: true } } } });
    return json(response, 200, { messages });
  }
  if (request.method === 'POST' && url.pathname === '/api/messages') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const body = await readBody(request);
    const text = requireText(body?.body, 2000);
    const recipientId = typeof body?.recipientId === 'string' ? body.recipientId : null;
    const channelId = typeof body?.channelId === 'string' ? body.channelId : null;
    if (!text || (recipientId && channelId) || (!recipientId && !channelId)) return json(response, 400, { error: 'INVALID_MESSAGE' });
    if (contentCheck(text)) return json(response, 422, { error: 'CONTENT_REJECTED' });
    const message = await prisma.message.create({ data: { senderId: user.id, recipientId, channelId, body: text }, select: { id: true, senderId: true, recipientId: true, channelId: true, body: true, createdAt: true } });
    if (recipientId) broadcastEvent(recipientId, { type: 'message', message });
    return json(response, 201, { message });
  }

  if (request.method === 'POST' && url.pathname === '/api/media') {
    const user = await authenticatedUser(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    const contentType = request.headers['content-type'] || '';
    const raw = await readRawBody(request);
    const multipart = raw && parseMultipart(contentType, raw);
    if (!multipart?.file || !/^video\/(mp4|webm|quicktime|x-matroska)$/.test(multipart.file.contentType)) return json(response, 400, { error: 'VIDEO_REQUIRED' });
    const extension = multipart.file.filename.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
    const key = `users/${user.id}/${randomBytes(16).toString('hex')}.${extension}`;
    await s3.send(new PutObjectCommand({ Bucket: process.env.MINIO_BUCKET || 'nexa-media', Key: key, Body: multipart.file.buffer, ContentType: multipart.file.contentType, Metadata: { ownerId: user.id } }));
    const mediaUrl = `/api/media/${encodeURIComponent(key)}`;
    let moderationJobId = null;
    let moderationS3Key = null;
    if (mediaModerationEnabled() && ['video/mp4', 'video/quicktime'].includes(multipart.file.contentType)) {
      moderationS3Key = `pending/${user.id}/${randomBytes(16).toString('hex')}.${extension}`;
      try {
        const bucket = process.env.AWS_S3_BUCKET;
        await moderationS3.send(new PutObjectCommand({ Bucket: bucket, Key: moderationS3Key, Body: multipart.file.buffer, ContentType: multipart.file.contentType }));
        const scan = await rekognition.send(new StartContentModerationCommand({
          Video: { S3Object: { Bucket: bucket, Name: moderationS3Key } },
          NotificationChannel: { SNSTopicArn: process.env.AWS_REKOGNITION_SNS_TOPIC_ARN, RoleArn: process.env.AWS_REKOGNITION_ROLE_ARN },
          MinConfidence: Number(process.env.AWS_REKOGNITION_MIN_CONFIDENCE || 75)
        }));
        if (!scan.JobId) throw new Error('REKOGNITION_JOB_ID_MISSING');
        moderationJobId = scan.JobId;
        await redis.set(`media_moderation:${moderationJobId}`, JSON.stringify({ userId: user.id, mediaUrl, moderationS3Key }), 'EX', 24 * 60 * 60);
      } catch (error) {
        await moderationS3.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: moderationS3Key })).catch(() => {});
        console.error('AWS media moderation could not start:', error.message);
        return json(response, 503, { error: 'MEDIA_MODERATION_UNAVAILABLE' });
      }
    }
    return json(response, 201, { key, mediaUrl, moderationJobId, scanMode: moderationJobId ? 'automatic' : 'manual_review' });
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/media/')) {
    const key = decodeURIComponent(url.pathname.slice('/api/media/'.length));
    if (!/^users\/[a-f0-9-]+\/[a-f0-9]+\.[a-z0-9]+$/i.test(key)) return json(response, 400, { error: 'INVALID_MEDIA_KEY' });
    const mediaUrl = `/api/media/${encodeURIComponent(key)}`;
    const post = await prisma.post.findFirst({ where: { mediaUrl, deletedAt: null }, select: { authorId: true, moderationStatus: true } });
    if (!post) return json(response, 404, { error: 'MEDIA_NOT_FOUND' });
    if (post.moderationStatus !== 'approved') {
      const user = await authenticatedUser(request);
      if (!user || (user.id !== post.authorId && user.role !== 'owner' && user.role !== 'moderator')) return json(response, 404, { error: 'MEDIA_NOT_FOUND' });
    }
    const object = await s3.send(new GetObjectCommand({ Bucket: process.env.MINIO_BUCKET || 'nexa-media', Key: key }));
    response.writeHead(200, { 'Content-Type': object.ContentType || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
    object.Body.pipe(response);
    return;
  }

  if (url.pathname.startsWith('/api/owner/ai')) {
    const user = await readSession(request);
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    if (user.role !== 'owner') return json(response, 403, { error: 'OWNER_ONLY' });
    if (request.method === 'GET' && url.pathname === '/api/owner/ai/status') {
      return json(response, 200, { enabled: true, mode: 'proposals-only', historyCount: await prisma.aIHistory.count({ where: { ownerId: user.id } }) });
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/ai/proposals') {
      const body = await readBody(request);
      if (!body || typeof body.proposal !== 'string' || !body.proposal.trim()) return json(response, 400, { error: 'PROPOSAL_REQUIRED' });
      const proposal = { id: randomBytes(12).toString('hex'), ownerId: user.id, proposal: body.proposal.trim(), status: 'proposed', createdAt: new Date().toISOString() };
      await prisma.aIHistory.create({ data: { ownerId: user.id, action: 'proposal', proposal: { text: proposal.proposal }, status: 'proposed' } });
      return json(response, 201, proposal);
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/ai/ask') {
      if (!process.env.DEEPSEEK_API_KEY) return json(response, 503, { error: 'DEEPSEEK_NOT_CONFIGURED' });
      const body = await readBody(request);
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 4000) : '';
      if (!prompt) return json(response, 400, { error: 'PROMPT_REQUIRED' });
      const aiResponse = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: 'You are NEXA PRIME owner assistant. Suggest and analyze only. Never delete or mutate data.' }, { role: 'user', content: prompt }], temperature: 0.2 }) });
      if (!aiResponse.ok) return json(response, 502, { error: 'DEEPSEEK_REQUEST_FAILED' });
      const result = await aiResponse.json();
      const answer = result.choices?.[0]?.message?.content || '';
      await prisma.aIHistory.create({ data: { ownerId: user.id, action: 'deepseek_request', proposal: { prompt, answer, model: result.model || 'deepseek-chat' }, status: 'proposed' } });
      return json(response, 200, { answer, model: result.model || 'deepseek-chat' });
    }
  }

  if (request.method === 'POST' && url.pathname === '/auth/register') {
    if (!smtpEnabled()) return json(response, 503, { error: 'SMTP_NOT_CONFIGURED' });
    const body = await readBody(request);
    const parsed = credentialsSchema.safeParse(body);
    if (!parsed.success) return json(response, 400, { error: 'INVALID_CREDENTIALS' });
    const email = parsed.data.email.toLowerCase();
    if (await prisma.user.findUnique({ where: { email } })) return json(response, 409, { error: 'EMAIL_IN_USE' });
    const accountOrder = await prisma.user.count();
    const usernameBase = email.split('@')[0].replace(/[^A-Za-z0-9_]/g, '_').slice(0, 18) || `user_${accountOrder}`;
    const user = await prisma.user.create({ data: { email, displayName: usernameBase, username: `${usernameBase}_${accountOrder}`, verification: 'standard', identities: { create: { provider: 'email', providerSubject: email, passwordHash: await bcrypt.hash(parsed.data.password, 12) } } } });
    const token = await createEmailToken(user.id, 'verify', 24 * 60);
    await sendSecurityMail({ to: email, subject: 'فعّل حساب NEXA PRIME', title: 'تأكيد البريد الإلكتروني', text: 'اضغط الرابط لتفعيل حسابك.', link: `${appOrigin}/auth/verify-email?token=${encodeURIComponent(token)}` });
    return json(response, 201, { user: publicUser(user), message: 'VERIFICATION_EMAIL_SENT' });
  }

  if (request.method === 'POST' && url.pathname === '/auth/login') {
    const body = await readBody(request);
    const parsed = credentialsSchema.safeParse(body);
    if (!parsed.success) return json(response, 400, { error: 'INVALID_CREDENTIALS' });
    const email = parsed.data.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email }, include: { identities: true } });
    const identity = user?.identities.find(item => item.provider === 'email');
    if (!user || !identity?.passwordHash) return json(response, 401, { error: 'INVALID_LOGIN' });
    if (user.lockedUntil && user.lockedUntil > new Date()) return json(response, 423, { error: 'ACCOUNT_TEMPORARILY_LOCKED' });
    if (!await bcrypt.compare(parsed.data.password, identity.passwordHash)) {
      const failedLogins = user.failedLogins + 1;
      await prisma.user.update({ where: { id: user.id }, data: { failedLogins, lockedUntil: failedLogins >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null } });
      return json(response, 401, { error: 'INVALID_LOGIN' });
    }
    if (!user.emailVerified) return json(response, 403, { error: 'EMAIL_NOT_VERIFIED' });
    const updatedUser = await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    await setSession(response, updatedUser);
    return json(response, 200, { user: publicUser(updatedUser) });
  }

  if (request.method === 'GET' && url.pathname === '/auth/verify-email') {
    const token = url.searchParams.get('token') || '';
    const record = await prisma.emailToken.findFirst({ where: { tokenHash: hashToken(token), type: 'verify', usedAt: null, expiresAt: { gt: new Date() } } });
    if (!record) return json(response, 400, { error: 'INVALID_OR_EXPIRED_TOKEN' });
    await prisma.$transaction([prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }), prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } })]);
    return json(response, 200, { ok: true, message: 'EMAIL_VERIFIED' });
  }

  if (request.method === 'POST' && url.pathname === '/auth/request-password-reset') {
    if (!smtpEnabled()) return json(response, 503, { error: 'SMTP_NOT_CONFIGURED' });
    const body = await readBody(request);
    const email = typeof body?.email === 'string' ? body.email.toLowerCase() : '';
    const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
    if (user) {
      const token = await createEmailToken(user.id, 'reset', 30);
      await sendSecurityMail({ to: email, subject: 'استرجاع حساب NEXA PRIME', title: 'إعادة تعيين كلمة المرور', text: 'استخدم الرمز التالي لإعادة تعيين كلمة المرور:', link: `${appOrigin}/reset-password?token=${encodeURIComponent(token)}` });
    }
    return json(response, 200, { ok: true, message: 'RESET_EMAIL_IF_ACCOUNT_EXISTS' });
  }

  if (request.method === 'POST' && url.pathname === '/auth/reset-password') {
    const body = await readBody(request);
    const parsed = credentialsSchema.safeParse({ email: body?.email, password: body?.password });
    const token = typeof body?.token === 'string' ? body.token : '';
    if (!parsed.success || !token) return json(response, 400, { error: 'INVALID_RESET_REQUEST' });
    const record = await prisma.emailToken.findFirst({ where: { tokenHash: hashToken(token), type: 'reset', usedAt: null, expiresAt: { gt: new Date() }, user: { email: parsed.data.email.toLowerCase() } } });
    if (!record) return json(response, 400, { error: 'INVALID_OR_EXPIRED_TOKEN' });
    await prisma.$transaction([prisma.emailToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }), prisma.authIdentity.updateMany({ where: { userId: record.userId, provider: 'email' }, data: { passwordHash: await bcrypt.hash(parsed.data.password, 12) } })]);
    return json(response, 200, { ok: true });
  }

  if (request.method === 'GET' && url.pathname === '/auth/google') {
    if (!oauthEnabled()) return json(response, 503, { error: 'GOOGLE_OAUTH_NOT_CONFIGURED', message: 'Set Google OAuth variables in .env.local.' });
    const sessionId = parseCookies(request).nexa_oauth_session || randomBytes(32).toString('base64url');
    const state = randomBytes(64).toString('base64url');
    await redis.set(`oauth_state:${sessionId}`, state, 'EX', 300);
    await redis.set(`oauth_session:${sessionId}`, JSON.stringify({ status: 'pending_google', session_id: sessionId, oauth_state: state, temp_user_status: 'pending_google' }), 'EX', 300);
    response.setHeader('Set-Cookie', [
      cookieString('nexa_oauth_session', sessionId, { maxAge: 600, secure: usesSecureCookies(), sameSite: usesSecureCookies() ? 'None' : 'Lax', path: '/', httpOnly: true })
    ]);
    const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: process.env.GOOGLE_REDIRECT_URI, response_type: 'code', scope: 'openid email profile', state, access_type: 'offline', prompt: 'select_account' });
    response.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    return response.end();
  }

  if (request.method === 'GET' && url.pathname === '/auth/google/callback') {
    const receivedState = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code');
    if (!code || !receivedState) return json(response, 400, { error: 'MISSING_AUTH_CODE' });
    const sessionId = parseCookies(request).nexa_oauth_session || '';
    const storedState = sessionId ? (await redis.get(`oauth_state:${sessionId}`)) || '' : '';
    if (!sessionId || !storedState || receivedState !== storedState) {
      await redis.del(`oauth_state:${sessionId}`);
      await redis.del(`oauth_session:${sessionId}`);
      return json(response, 400, { error: 'INVALID_OAUTH_STATE' });
    }
    await redis.del(`oauth_state:${sessionId}`);
    await redis.del(`oauth_session:${sessionId}`);
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: process.env.GOOGLE_REDIRECT_URI, grant_type: 'authorization_code' }) });
    if (!tokenResponse.ok) return json(response, 401, { error: 'GOOGLE_TOKEN_EXCHANGE_FAILED' });
    const tokens = await tokenResponse.json();
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!profileResponse.ok) return json(response, 401, { error: 'GOOGLE_PROFILE_FAILED' });
    const profile = await profileResponse.json();
    const email = String(profile.email || '').trim().toLowerCase();
    if (!email) return json(response, 400, { error: 'GOOGLE_EMAIL_MISSING' });
    const providerSubject = String(profile.sub);
    let user = await prisma.user.findUnique({ where: { email } }) || await prisma.user.findFirst({ where: { authIdentities: { some: { provider: 'google', providerSubject } } } });
    const firstUser = await prisma.user.count();
    if (!user) {
      const displayName = String(profile.name || email.split('@')[0] || 'NEXA User').slice(0, 30);
      const baseUsername = (String(profile.name || email.split('@')[0] || 'user').replace(/[^A-Za-z0-9_]/g, '_') || `user_${firstUser + 1}`).slice(0, 18);
      const nextIndex = (firstUser + 1).toString(36);
      const username = `${baseUsername}_${nextIndex}`;
      user = await prisma.user.create({ data: { email, displayName, username, avatarUrl: profile.picture || null, role: firstUser === 0 ? 'owner' : 'user', verification: firstUser === 0 ? 'gold' : firstUser <= 2 ? 'yellow' : 'standard', emailVerified: true } });
    }
    const existingIdentity = await prisma.authIdentity.findUnique({ where: { provider_providerSubject: { provider: 'google', providerSubject } } });
    if (!existingIdentity || existingIdentity.userId !== user.id) {
      await prisma.authIdentity.upsert({ where: { provider_providerSubject: { provider: 'google', providerSubject } }, update: { userId: user.id }, create: { userId: user.id, provider: 'google', providerSubject: String(profile.sub) } });
    }
    if (!user.displayName || !user.username || !user.avatarUrl) {
      const baseName = String(profile.name || user.displayName || email.split('@')[0] || 'NEXA User').replace(/[^\p{L}\p{N}_\s]/gu, ' ').trim().slice(0, 30) || 'NEXA User';
      const usernameBase = String(user.username || (email.split('@')[0].replace(/[^A-Za-z0-9_]/g, '_') || 'user')).slice(0, 18);
      const nextUsername = user.username || `${usernameBase}_${(user.id || '').slice(-4) || Math.random().toString(36).slice(2, 6)}`;
      user = await prisma.user.update({ where: { id: user.id }, data: { displayName: baseName, username: nextUsername.slice(0, 20), avatarUrl: user.avatarUrl || profile.picture || null, emailVerified: true } });
    }
    const sessionPayload = buildSessionUser({ ...user, status: 'needs_profile_setup', emailVerified: true });
    await setSession(response, sessionPayload);
    const frontendBase = process.env.APP_ORIGIN || process.env.FRONTEND_ORIGIN || appOrigin;
    response.writeHead(302, { Location: `${frontendBase.replace(/\/$/, '')}/setup-profile` });
    return response.end();
  }

  if (request.method === 'POST' && url.pathname === '/auth/refresh') {
    const refreshToken = parseCookies(request).nexa_refresh || '';
    const refreshHash = hashToken(refreshToken);
    const userId = refreshToken ? await redis.get(`refresh:${refreshHash}`) : null;
    const session = userId ? await prisma.session.findFirst({ where: { userId, refreshTokenHash: refreshHash, revokedAt: null, expiresAt: { gt: new Date() } } }) : null;
    if (!session) return json(response, 401, { error: 'INVALID_REFRESH_TOKEN' });
    await redis.del(`refresh:${refreshHash}`);
    await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return json(response, 401, { error: 'AUTH_REQUIRED' });
    await setSession(response, user);
    return json(response, 200, { user: publicUser(user) });
  }

  if (request.method === 'POST' && url.pathname === '/auth/logout') {
    const refreshToken = parseCookies(request).nexa_refresh || '';
    const refreshHash = refreshToken ? hashToken(refreshToken) : '';
    if (refreshHash) {
      await redis.del(`refresh:${refreshHash}`);
      await prisma.session.updateMany({ where: { refreshTokenHash: refreshHash, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    response.setHeader('Set-Cookie', ['nexa_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', 'nexa_refresh=; HttpOnly; SameSite=Strict; Path=/auth; Max-Age=0']);
    return json(response, 200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/moderation/check') {
    const body = await readBody(request);
    if (!body || typeof body.text !== 'string') return json(response, 400, { error: 'TEXT_REQUIRED' });
    const matched = contentCheck(body.text);
    return json(response, 200, { allowed: !matched, matched });
  }

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(process.cwd(), 'dist');
    const safePath = path.normalize(url.pathname).replace(/^\/+/, '');
    const filePath = path.join(distDir, safePath || 'index.html');
    try {
      const resolved = await fs.realpath(distDir);
      const target = await fs.realpath(filePath).catch(() => null);
      if (target && target.startsWith(resolved + path.sep) || filePath === path.join(resolved, 'index.html')) {
        const stat = await fs.stat(filePath);
        if (stat.isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          const mimeType = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
          response.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=3600' });
          return response.end(await fs.readFile(filePath));
        }
      }
      const index = await fs.readFile(path.join(distDir, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(index);
    } catch {
      // Fall through to the API 404 response for unknown routes.
    }
  }

  return json(response, 404, { error: 'NOT_FOUND' });
}

if (!sessionSecret) console.warn('NEXA API: SESSION_SECRET is missing; authenticated sessions are disabled.');
const server = createServer((request, response) => { requestCount += 1; handle(request, response).catch(error => { errorCount += 1; console.error(error); json(response, 500, { error: 'INTERNAL_SERVER_ERROR' }); }); });

let moderationPollRunning = false;
async function processPendingMediaModeration() {
  if (!servicesReady || !mediaModerationEnabled() || moderationPollRunning) return;
  moderationPollRunning = true;
  try {
    const pendingPosts = await prisma.post.findMany({
      where: { moderationStatus: 'pending', moderationJobId: { not: null } },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true, moderationJobId: true, moderationS3Key: true }
    });
    for (const post of pendingPosts) {
      try {
        const result = await inspectVideoModeration(rekognition, post.moderationJobId);
        if (result.status === 'pending') continue;
        const labels = result.labels.map(label => label.Name).filter(Boolean);
        const update = await prisma.post.updateMany({
          where: { id: post.id, moderationStatus: 'pending', moderationJobId: post.moderationJobId },
          data: { moderationStatus: result.status === 'approved' ? 'approved' : 'pending', moderationJobId: null, moderationS3Key: null, moderationLabels: result.labels }
        });
        if (update.count) {
          await prisma.moderationLog.create({ data: {
            targetType: 'post',
            targetId: post.id,
            action: result.status === 'approved' ? 'automatic_approval' : 'automatic_flag',
            reason: result.status === 'approved' ? 'aws_rekognition_no_labels' : `aws_rekognition_review:${labels.join(',').slice(0, 400) || 'scan_failed'}`
          } });
        }
        if (post.moderationS3Key) await moderationS3.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: post.moderationS3Key })).catch(() => {});
      } catch (error) {
        console.error(`AWS moderation polling failed for post ${post.id}:`, error.message);
      }
    }
  } finally {
    moderationPollRunning = false;
  }
}

const websocketServer = new WebSocketServer({ noServer: true });
server.on('upgrade', async (request, socket, head) => {
  if (!servicesReady || !request.url?.startsWith('/ws')) return socket.destroy();
  const user = await readSession(request);
  if (!user?.id) return socket.destroy();
  websocketServer.handleUpgrade(request, socket, head, client => {
    websocketServer.emit('connection', client, user);
  });
});
websocketServer.on('connection', (client, user) => {
  const clients = liveClients[user.id] || (liveClients[user.id] = new Set());
  clients.add(client);
  client.send(JSON.stringify({ type: 'ready', userId: user.id }));
  client.on('close', () => {
    clients.delete(client);
    if (!clients.size) delete liveClients[user.id];
  });
});
connectServices().then(() => {
  servicesReady = true;
  processPendingMediaModeration().catch(error => console.error('AWS moderation worker failed:', error.message));
  const moderationTimer = setInterval(() => processPendingMediaModeration().catch(error => console.error('AWS moderation worker failed:', error.message)), 15000);
  moderationTimer.unref();
  server.listen(port, '0.0.0.0', () => console.log(`NEXA API listening on http://localhost:${port}`));
}).catch(error => {
  console.error('NEXA API started in degraded mode because PostgreSQL, Redis, or MinIO is unavailable.', error.message);
  servicesReady = false;
  server.listen(port, '0.0.0.0', () => console.log(`NEXA API listening in degraded mode on http://localhost:${port}`));
});
process.on('SIGTERM', async () => { await disconnectServices(); server.close(); });