import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { presignUrl } from '../src/lib/storage/sigv4';
import { api, app, loginAs, unique, type Session } from './helpers';

/**
 * Oversized uploads are answered with 413 while the client is still sending,
 * which supertest reports as EPIPE. A raw client streams in chunks and stops
 * as soon as the response arrives, like a browser does.
 */
let server: Server;
let origin: string;
function streamUpload(path: string, headers: Record<string, string>, totalBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, { method: 'PUT', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') reject(err);
    });
    const chunk = Buffer.alloc(64 * 1024, 1);
    let sent = 0;
    const pump = () => {
      while (sent < totalBytes && !req.destroyed) {
        sent += chunk.length;
        if (!req.write(chunk)) return void req.once('drain', pump);
      }
      if (!req.destroyed) req.end();
    };
    pump();
  });
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let superadmin: Session;
let admin: Session;
let manager: Session;
let employee: Session;
/** Managed by `manager`, with `employee` as a member. */
let sharedProjectId: string;
/** Managed by `manager`; `employee` is not in it. */
let privateProjectId: string;

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(256, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(256, 3)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  [superadmin, admin, manager, employee] = await Promise.all([loginAs('superadmin'), loginAs('admin'), loginAs('manager'), loginAs('employee')]);
  const project = (memberIds: string[]) =>
    superadmin
      .auth(api().post('/api/projects'))
      .send({ name: unique('Rec'), status: 'ACTIVE', priority: 'MEDIUM', startDate: '2026-10-01', managerId: manager.userId, memberIds });
  const [shared, priv] = await Promise.all([project([employee.userId]), project([])]);
  sharedProjectId = shared.body.data.id;
  privateProjectId = priv.body.data.id;
});

beforeEach(async () => {
  const keys = await redis.keys('rl:recording*');
  if (keys.length) await redis.del(...keys);
});

type Upload = { recordingId: string; upload: { url: string; method: string; headers: Record<string, string> }; thumbnailUpload: { url: string; headers: Record<string, string> } | null };

async function startUpload(s: Session, body: Record<string, unknown> = {}): Promise<Upload> {
  const res = await s.auth(api().post('/api/recordings/upload-url')).send({ mimeType: 'video/webm;codecs=vp9,opus', fileSize: WEBM.length, recordingType: 'FULL_SCREEN', ...body });
  expect(res.status).toBe(201);
  return res.body.data;
}

const put = (signed: { url: string; headers: Record<string, string> }, bytes: Buffer) => api().put(signed.url).set(signed.headers).send(bytes);

async function saveRecording(s: Session, extra: { projectId?: string | null; title?: string; bytes?: Buffer; mimeType?: string } = {}) {
  const { bytes = WEBM, mimeType = 'video/webm', ...rest } = extra;
  const up = await startUpload(s, { mimeType, fileSize: bytes.length, projectId: rest.projectId });
  expect((await put(up.upload, bytes)).status).toBe(200);
  const res = await s
    .auth(api().post('/api/recordings/complete'))
    .send({ recordingId: up.recordingId, title: rest.title ?? unique('Demo'), recordingType: 'FULL_SCREEN', duration: 42, tags: ['demo', 'Demo', 'qa'], projectId: rest.projectId });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; playbackUrl: string; downloadUrl: string; fileSize: number; tags: string[]; canDelete: boolean };
}

describe('SigV4 presigning', () => {
  it('matches the AWS documentation example for a presigned GET', () => {
    const url = presignUrl({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresInSeconds: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(url).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request');
  });
});

describe('Recording upload flow', () => {
  it('uploads to a signed URL, verifies the stored file and serves it back with range support', async () => {
    const up = await startUpload(employee);
    expect(up.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'video/webm' } });
    expect(up.upload.url).toMatch(/^\/api\/storage\//);
    expect((await put(up.upload, WEBM)).status).toBe(200);

    const done = await employee
      .auth(api().post('/api/recordings/complete'))
      .send({ recordingId: up.recordingId, title: '  Sprint demo  ', description: 'Walkthrough', recordingType: 'SCREEN_WEBCAM', duration: 42, tags: ['demo', 'DEMO', 'ui'], fileSize: 999 });
    // fileSize is not part of the completion payload: the server measures it.
    expect(done.status).toBe(400);

    const ok = await employee
      .auth(api().post('/api/recordings/complete'))
      .send({ recordingId: up.recordingId, title: '  Sprint demo  ', description: 'Walkthrough', recordingType: 'SCREEN_WEBCAM', duration: 42, tags: ['demo', 'DEMO', 'ui'] });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({
      title: 'Sprint demo',
      description: 'Walkthrough',
      recordingType: 'SCREEN_WEBCAM',
      duration: 42,
      fileSize: WEBM.length,
      mimeType: 'video/webm',
      tags: ['demo', 'ui'],
      owner: { id: employee.userId },
      project: null,
      thumbnailUrl: null,
      canDelete: true,
    });

    const video = await api().get(ok.body.data.playbackUrl).responseType('blob');
    expect(video.status).toBe(200);
    expect(video.headers['content-type']).toBe('video/webm');
    expect(Buffer.from(video.body as Buffer).equals(WEBM)).toBe(true);
    const range = await api().get(ok.body.data.playbackUrl).set('Range', 'bytes=0-3');
    expect(range.status).toBe(206);
    const download = await api().get(ok.body.data.downloadUrl);
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="Sprint demo\.webm"/);

    const row = await prisma.recording.findUniqueOrThrow({ where: { id: up.recordingId } });
    expect(row.storageKey).toBe(`recordings/${employee.userId}/${up.recordingId}/video.webm`);
    expect(row.status).toBe('READY');

    // Completing twice is refused.
    const again = await employee.auth(api().post('/api/recordings/complete')).send({ recordingId: up.recordingId, title: 'x', recordingType: 'WINDOW' });
    expect(again.status).toBe(404);
  });

  it('accepts MP4 from Safari and stores a verified thumbnail', async () => {
    const up = await startUpload(employee, { mimeType: 'video/mp4', fileSize: MP4.length, thumbnail: { mimeType: 'image/jpeg', fileSize: JPEG.length } });
    expect(up.thumbnailUpload).not.toBeNull();
    expect((await put(up.upload, MP4)).status).toBe(200);
    expect((await put(up.thumbnailUpload!, JPEG)).status).toBe(200);
    const res = await employee.auth(api().post('/api/recordings/complete')).send({ recordingId: up.recordingId, title: 'Safari', recordingType: 'WEBCAM' });
    expect(res.status).toBe(201);
    expect(res.body.data.mimeType).toBe('video/mp4');
    const thumb = await api().get(res.body.data.thumbnailUrl);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
  });

  it('drops a thumbnail whose content is not an image, but keeps the recording', async () => {
    const up = await startUpload(employee, { thumbnail: { mimeType: 'image/jpeg', fileSize: 10 } });
    await put(up.upload, WEBM);
    await put(up.thumbnailUpload!, Buffer.from('not a jpeg'));
    const res = await employee.auth(api().post('/api/recordings/complete')).send({ recordingId: up.recordingId, title: 'No thumb', recordingType: 'WINDOW' });
    expect(res.status).toBe(201);
    expect(res.body.data.thumbnailUrl).toBeNull();
  });

  it('refuses to complete before the file is uploaded', async () => {
    const up = await startUpload(employee);
    const res = await employee.auth(api().post('/api/recordings/complete')).send({ recordingId: up.recordingId, title: 'Early', recordingType: 'WINDOW' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UPLOAD_INCOMPLETE');
    await prisma.recording.delete({ where: { id: up.recordingId } });
  });

  it('rejects a file whose bytes are not the declared video type and removes it', async () => {
    const up = await startUpload(employee);
    await put(up.upload, Buffer.from('<html>definitely not a video</html>'));
    const res = await employee.auth(api().post('/api/recordings/complete')).send({ recordingId: up.recordingId, title: 'Fake', recordingType: 'WINDOW' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(await prisma.recording.findUnique({ where: { id: up.recordingId } })).toBeNull();
  });

  it('validates MIME type and size before issuing a URL', async () => {
    const bad = await employee.auth(api().post('/api/recordings/upload-url')).send({ mimeType: 'application/x-msdownload', fileSize: 10, recordingType: 'WINDOW' });
    expect(bad.status).toBe(400);
    const big = await employee.auth(api().post('/api/recordings/upload-url')).send({ mimeType: 'video/webm', fileSize: env.RECORDING_MAX_BYTES + 1, recordingType: 'WINDOW' });
    expect(big.status).toBe(400);
    const type = await employee.auth(api().post('/api/recordings/upload-url')).send({ mimeType: 'video/webm', fileSize: 10, recordingType: 'SCREENSHOT' });
    expect(type.status).toBe(400);
  });

  it('enforces the size limit and signature on the upload URL itself', async () => {
    const up = await startUpload(employee);
    const over = env.RECORDING_MAX_BYTES + 128 * 1024;
    // Declared too large: refused from the headers alone.
    expect(await streamUpload(up.upload.url, { ...up.upload.headers, 'Content-Length': String(over) }, over)).toBe(413);
    // Not declared (chunked): cut off once the limit is crossed, and nothing is kept.
    expect(await streamUpload(up.upload.url, { ...up.upload.headers, 'Transfer-Encoding': 'chunked' }, over)).toBe(413);
    const incomplete = await employee.auth(api().post('/api/recordings/complete')).send({ recordingId: up.recordingId, title: 'Big', recordingType: 'WINDOW' });
    expect(incomplete.body.code).toBe('UPLOAD_INCOMPLETE');
    const wrongType = await api().put(up.upload.url).set('Content-Type', 'text/html').send(WEBM);
    expect(wrongType.status).toBe(403);
    const tampered = await api().put(up.upload.url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))).set(up.upload.headers).send(WEBM);
    expect(tampered.status).toBe(403);
    await prisma.recording.delete({ where: { id: up.recordingId } });
  });

  it('only lets the owner complete their upload', async () => {
    const up = await startUpload(employee);
    await put(up.upload, WEBM);
    const res = await manager.auth(api().post('/api/recordings/complete')).send({ recordingId: up.recordingId, title: 'Hijack', recordingType: 'WINDOW' });
    expect(res.status).toBe(404);
    await prisma.recording.delete({ where: { id: up.recordingId } });
  });

  it('caps the number of unfinished uploads per person', async () => {
    const before = await prisma.recording.count({ where: { userId: manager.userId, status: 'UPLOADING' } });
    const ids: string[] = [];
    for (let i = before; i < 5; i++) ids.push((await startUpload(manager)).recordingId);
    const res = await manager.auth(api().post('/api/recordings/upload-url')).send({ mimeType: 'video/webm', fileSize: 10, recordingType: 'WINDOW' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TOO_MANY_PENDING_UPLOADS');
    await prisma.recording.deleteMany({ where: { id: { in: ids } } });
  });

  it('requires authentication', async () => {
    expect((await api().get('/api/recordings')).status).toBe(401);
    expect((await api().post('/api/recordings/upload-url').send({})).status).toBe(401);
  });
});

describe('Recording access', () => {
  it('keeps a recording private to its owner unless it is attached to a project', async () => {
    const mine = await saveRecording(employee, { title: unique('Private') });
    expect((await manager.auth(api().get(`/api/recordings/${mine.id}`))).status).toBe(404);
    const list = await manager.auth(api().get('/api/recordings')).query({ limit: 100 });
    expect(list.body.data.map((r: { id: string }) => r.id)).not.toContain(mine.id);
    expect((await manager.auth(api().delete(`/api/recordings/${mine.id}`))).status).toBe(404);

    // Admins hold recordings.manage_all.
    const viaAdmin = await admin.auth(api().get(`/api/recordings/${mine.id}`));
    expect(viaAdmin.status).toBe(200);
    expect(viaAdmin.body.data.canDelete).toBe(true);
  });

  it('shares a project recording with its members; the project manager may delete it, other members may not', async () => {
    const shared = await saveRecording(manager, { projectId: sharedProjectId, title: unique('Shared') });
    const seen = await employee.auth(api().get(`/api/recordings/${shared.id}`));
    expect(seen.status).toBe(200);
    expect(seen.body.data).toMatchObject({ project: { id: sharedProjectId }, owner: { id: manager.userId }, canDelete: false });
    expect((await employee.auth(api().delete(`/api/recordings/${shared.id}`))).status).toBe(403);

    const byEmployee = await saveRecording(employee, { projectId: sharedProjectId });
    expect((await manager.auth(api().get(`/api/recordings/${byEmployee.id}`))).body.data.canDelete).toBe(true);
    expect((await manager.auth(api().delete(`/api/recordings/${byEmployee.id}`))).status).toBe(200);
    expect((await employee.auth(api().get(`/api/recordings/${byEmployee.id}`))).status).toBe(404);
  });

  it('refuses to attach a recording to a project the user cannot see', async () => {
    const res = await employee.auth(api().post('/api/recordings/upload-url')).send({ mimeType: 'video/webm', fileSize: 10, recordingType: 'WINDOW', projectId: privateProjectId });
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('projectId');

    const up = await startUpload(employee);
    await put(up.upload, WEBM);
    const complete = await employee.auth(api().post('/api/recordings/complete')).send({ recordingId: up.recordingId, title: 'Sneaky', recordingType: 'WINDOW', projectId: privateProjectId });
    expect(complete.status).toBe(400);
    await prisma.recording.delete({ where: { id: up.recordingId } });
  });

  it('deletes the row and the stored file', async () => {
    const rec = await saveRecording(employee);
    expect((await employee.auth(api().delete(`/api/recordings/${rec.id}`))).status).toBe(200);
    expect((await api().get(rec.playbackUrl)).status).toBe(404);
    expect(await prisma.recording.findUnique({ where: { id: rec.id } })).toBeNull();
  });
});

describe('GET /api/recordings', () => {
  it('searches, filters and sorts within the caller’s scope, without exposing storage keys', async () => {
    const tag = unique('needle');
    const a = await saveRecording(employee, { title: `${tag} alpha` });
    const b = await saveRecording(employee, { title: `${tag} beta`, projectId: sharedProjectId });

    const found = await employee.auth(api().get('/api/recordings')).query({ search: tag, sortBy: 'title', sortOrder: 'asc' });
    expect(found.status).toBe(200);
    expect(found.body.data.map((r: { id: string }) => r.id)).toEqual([a.id, b.id]);
    expect(found.body.meta).toMatchObject({ total: 2, page: 1 });
    expect(found.body.data[0]).not.toHaveProperty('storageKey');
    expect(found.body.data[0]).not.toHaveProperty('playbackUrl');
    expect(found.headers['cache-control']).toBe('private, no-store');

    const byProject = await employee.auth(api().get('/api/recordings')).query({ search: tag, projectId: sharedProjectId });
    expect(byProject.body.data.map((r: { id: string }) => r.id)).toEqual([b.id]);

    const mine = await manager.auth(api().get('/api/recordings')).query({ search: tag, mine: 'true' });
    expect(mine.body.data).toHaveLength(0);
    // Without `mine`, the manager sees the project recording but not the private one.
    const managerView = await manager.auth(api().get('/api/recordings')).query({ search: tag });
    expect(managerView.body.data.map((r: { id: string }) => r.id)).toEqual([b.id]);

    const byType = await employee.auth(api().get('/api/recordings')).query({ search: tag, recordingType: 'WEBCAM' });
    expect(byType.body.data).toHaveLength(0);
  });
});
