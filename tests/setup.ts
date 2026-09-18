import { afterAll, vi } from 'vitest';

// API tests never talk to BullMQ: producers are replaced by spies so assertions
// can check *that* a job was enqueued without a worker running.
vi.mock('../src/queue/producers', () => ({
  producers: {
    welcomeEmail: vi.fn().mockResolvedValue(undefined),
    taskAssignedEmail: vi.fn().mockResolvedValue(undefined),
    taskStatusChangedEmail: vi.fn().mockResolvedValue(undefined),
    projectInvitationEmail: vi.fn().mockResolvedValue(undefined),
    userMessage: vi.fn().mockResolvedValue({ id: 'test-email-log-id' }),
    activity: vi.fn().mockResolvedValue(undefined),
  },
}));

afterAll(async () => {
  const { prisma } = await import('../src/lib/prisma');
  const { redis } = await import('../src/lib/redis');
  await prisma.$disconnect();
  await redis.quit().catch(() => undefined);
});
