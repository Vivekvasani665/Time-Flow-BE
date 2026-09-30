import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/common/errors';
import { deliverOtp, OTP_CHANNEL_TIMEOUT_MS } from '../src/modules/auth/otp-delivery';
import { resolveEnvTransport, sendMail, SMTP_TIMEOUTS } from '../src/queue/mailer';
import { smsService } from '../src/queue/sms';

vi.mock('../src/queue/mailer', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/queue/mailer')>()), sendMail: vi.fn() }));

const user = { id: 'u1', email: 'new@timeflow.dev', phone: '+919876543210', firstName: 'New', lastName: 'Person' };
const opts = (channels: ('email' | 'sms')[]) => ({
  user,
  otp: '123456',
  minutes: 10,
  channels,
  email: { to: user.email, subject: 'Code', html: '<p>123456</p>', text: '123456' },
  purpose: 'signup' as const,
  noneDelivered: () => new AppError(503, 'OTP_DELIVERY_FAILED', 'We could not send your verification code. Please try again in a moment.'),
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OTP delivery deadline', () => {
  it('gives up on a hanging mail server in time to answer the sign-up request with a clear error', async () => {
    vi.useFakeTimers();
    vi.mocked(sendMail).mockReturnValue(new Promise(() => undefined)); // e.g. a blocked SMTP port
    const result = deliverOtp(opts(['email'])).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(OTP_CHANNEL_TIMEOUT_MS);
    expect(await result).toMatchObject({ statusCode: 503, code: 'OTP_DELIVERY_FAILED' });
  });

  it('still succeeds through the channel that answered when the other one hangs', async () => {
    vi.useFakeTimers();
    vi.mocked(sendMail).mockReturnValue(new Promise(() => undefined));
    vi.spyOn(smsService, 'sendOtp').mockResolvedValue('sms-1');
    const result = deliverOtp(opts(['email', 'sms']));
    await vi.advanceTimersByTimeAsync(OTP_CHANNEL_TIMEOUT_MS);
    expect((await result).channels).toEqual(['sms']);
  });

  it('bounds SMTP connections, well under the frontend proxy timeout', () => {
    expect(OTP_CHANNEL_TIMEOUT_MS).toBeLessThan(30_000);
    expect(SMTP_TIMEOUTS.connectionTimeout).toBeLessThanOrEqual(10_000);
    const smtp = resolveEnvTransport().options as { connectionTimeout?: number; jsonTransport?: boolean };
    if (!smtp.jsonTransport) expect(smtp.connectionTimeout).toBe(SMTP_TIMEOUTS.connectionTimeout);
  });
});
