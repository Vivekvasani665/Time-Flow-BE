import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { producers } from '../src/queue/producers';
import { api, loginAs, unique, userId, type Session } from './helpers';

let superadmin: Session;
let manager: Session;
let employee: Session;
let projectId: string;
let kaiId: string;

beforeAll(async () => {
  [superadmin, manager, employee] = await Promise.all([loginAs('superadmin'), loginAs('manager'), loginAs('employee')]);
  kaiId = await userId('kai.morgan@timeflow.dev');
  const project = await superadmin.auth(api().post('/api/projects')).send({
    name: unique('Task Arena'),
    startDate: '2026-09-01',
    managerId: manager.userId,
    memberIds: [employee.userId, kaiId],
  });
  projectId = project.body.data.id;
});

describe('Task CRUD', () => {
  it('creates, reads, updates, and deletes a task; maintains completedAt', async () => {
    const created = await manager.auth(api().post('/api/tasks')).send({ title: 'Defeat the bug boss', projectId, assigneeId: employee.userId, priority: 'CRITICAL', dueDate: '2026-10-10' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'TODO', priority: 'CRITICAL', project: { id: projectId }, assignee: { id: employee.userId }, createdBy: { id: manager.userId }, completedAt: null });
    const id = created.body.data.id;

    const done = await manager.auth(api().patch(`/api/tasks/${id}`)).send({ status: 'COMPLETED' });
    expect(done.body.data.completedAt).not.toBeNull();
    const reopened = await manager.auth(api().patch(`/api/tasks/${id}`)).send({ status: 'IN_PROGRESS' });
    expect(reopened.body.data.completedAt).toBeNull();

    expect((await manager.auth(api().get(`/api/tasks/${id}`))).status).toBe(200);
    expect((await manager.auth(api().delete(`/api/tasks/${id}`))).status).toBe(200);
    expect((await manager.auth(api().get(`/api/tasks/${id}`))).status).toBe(404);
  });

  it('PATCH leaves fields that were not sent untouched', async () => {
    const created = await manager.auth(api().post('/api/tasks')).send({ title: 'Keep my description', description: 'Important notes', projectId, dueDate: '2026-11-01' });
    const res = await manager.auth(api().patch(`/api/tasks/${created.body.data.id}`)).send({ priority: 'LOW' });
    expect(res.body.data).toMatchObject({ description: 'Important notes', priority: 'LOW' });
    expect(res.body.data.dueDate).toMatch(/^2026-11-01/);
  });

  it('requires the assignee to belong to the project', async () => {
    const outsider = await userId('diego.alvarez@timeflow.dev');
    const res = await manager.auth(api().post('/api/tasks')).send({ title: 'Nope', projectId, assigneeId: outsider });
    expect(res.status).toBe(400);
    expect(res.body.details[0].path).toBe('assigneeId');
  });

  it('filters by status, project and assignee=me', async () => {
    await manager.auth(api().post('/api/tasks')).send({ title: 'Filter me', projectId, assigneeId: employee.userId, status: 'REVIEW' }).expect(201);
    const res = await employee.auth(api().get('/api/tasks')).query({ assigneeId: 'me', status: 'REVIEW', projectId });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((t: { status: string; assignee: { id: string } }) => t.status === 'REVIEW' && t.assignee.id === employee.userId)).toBe(true);
  });
});

describe('Task permissions & scoping', () => {
  it('an employee can change the status of their own task but nothing else', async () => {
    const task = await manager.auth(api().post('/api/tasks')).send({ title: 'My quest', projectId, assigneeId: employee.userId });
    const id = task.body.data.id;

    const status = await employee.auth(api().patch(`/api/tasks/${id}`)).send({ status: 'IN_PROGRESS' });
    expect(status.status).toBe(200);
    expect(status.body.data.status).toBe('IN_PROGRESS');

    const title = await employee.auth(api().patch(`/api/tasks/${id}`)).send({ title: 'Renamed' });
    expect(title.status).toBe(403);
  });

  it("an employee cannot see or edit someone else's task", async () => {
    const task = await manager.auth(api().post('/api/tasks')).send({ title: 'Kai only', projectId, assigneeId: kaiId });
    const id = task.body.data.id;
    expect((await employee.auth(api().get(`/api/tasks/${id}`))).status).toBe(404);
    expect((await employee.auth(api().patch(`/api/tasks/${id}`)).send({ status: 'COMPLETED' })).status).toBe(404);
    const list = await employee.auth(api().get('/api/tasks')).query({ projectId, limit: 100 });
    expect(list.body.data.map((t: { id: string }) => t.id)).not.toContain(id);
  });

  it('an employee cannot create or delete tasks', async () => {
    expect((await employee.auth(api().post('/api/tasks')).send({ title: 'x', projectId })).status).toBe(403);
    const task = await prisma.task.findFirstOrThrow({ where: { assigneeId: employee.userId, deletedAt: null } });
    expect((await employee.auth(api().delete(`/api/tasks/${task.id}`))).status).toBe(403);
  });
});

describe('Task assignment email', () => {
  beforeEach(() => vi.clearAllMocks());

  it('notifies the assignee, with the task detail the template needs', async () => {
    const created = await manager
      .auth(api().post('/api/tasks'))
      .send({ title: 'Escort the payload', description: 'Two crates.', projectId, assigneeId: kaiId, priority: 'HIGH', dueDate: '2026-11-05' });
    expect(created.status).toBe(201);

    expect(producers.taskAssignedEmail).toHaveBeenCalledTimes(1);
    expect(producers.taskAssignedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({ title: 'Escort the payload', description: 'Two crates.' }),
        assignee: expect.objectContaining({ id: kaiId }),
        assignedBy: expect.any(String),
      }),
    );
  });

  it('stays quiet when a task has no assignee', async () => {
    const created = await manager.auth(api().post('/api/tasks')).send({ title: 'Unclaimed bounty', projectId, priority: 'LOW' });
    expect(created.status).toBe(201);
    expect(producers.taskAssignedEmail).not.toHaveBeenCalled();
  });

  it('fires again when the task is handed to someone else', async () => {
    const created = await manager.auth(api().post('/api/tasks')).send({ title: 'Relay the sigil', projectId, assigneeId: kaiId });
    vi.clearAllMocks();

    const reassigned = await manager.auth(api().patch(`/api/tasks/${created.body.data.id}`)).send({ assigneeId: employee.userId });
    expect(reassigned.status).toBe(200);
    expect(producers.taskAssignedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ assignee: expect.objectContaining({ id: employee.userId }) }),
    );
  });
});
