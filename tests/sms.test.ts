import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { SmsError, smsService } from '../src/queue/sms';

const mutable = env as unknown as Record<string, unknown>;
const saved = { ...env };

afterEach(() => {
  Object.assign(mutable, saved);
  vi.unstubAllGlobals();
});

const configure = (vars: Record<string, unknown>) => Object.assign(mutable, { SMS_ALLOW_REAL_SEND: true, ...vars });
const respond = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: unknown) => e as SmsError);

describe('smsService', () => {
  it('does not claim a send when SMS_PROVIDER=log', async () => {
    configure({ SMS_PROVIDER: 'log' });
    expect((await failure(smsService.sendOtp('+919876543210', '123456', 5))).code).toBe('SMS_NOT_CONFIGURED');
  });

  it('refuses a real provider outside production unless allowed', async () => {
    configure({ SMS_PROVIDER: 'msg91', SMS_ALLOW_REAL_SEND: false, MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't' });
    expect((await failure(smsService.sendOtp('+919876543210', '123456', 5))).code).toBe('SMS_BLOCKED_IN_DEVELOPMENT');
  });

  it('reports missing credentials', async () => {
    configure({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM: undefined });
    expect((await failure(smsService.sendOtp('+919876543210', '123456', 5))).code).toBe('SMS_NOT_CONFIGURED');
  });

  it('sends through MSG91 with the DLT template, number without +, and sender id', async () => {
    configure({ SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'key', MSG91_TEMPLATE_ID: 'tpl', MSG91_SENDER_ID: 'TMFLOW' });
    respond(200, { type: 'success', message: 'req-1' });
    await expect(smsService.sendOtp('+919876543210', '482913', 5)).resolves.toBe('req-1');
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://control.msg91.com/api/v5/flow');
    expect(JSON.parse(String(init.body))).toMatchObject({ template_id: 'tpl', sender: 'TMFLOW', recipients: [{ mobiles: '919876543210', otp: '482913', minutes: '5' }] });
  });

  it('maps an MSG91 auth failure (HTTP 200 + type:error)', async () => {
    configure({ SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'bad', MSG91_TEMPLATE_ID: 'tpl' });
    respond(200, { type: 'error', message: 'Authentication failure' });
    expect((await failure(smsService.sendOtp('+919876543210', '482913', 5))).code).toBe('SMS_PROVIDER_AUTH_FAILED');
  });

  it('maps Twilio 401 and other rejections', async () => {
    configure({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15005550006' });
    respond(401, { code: 20003, message: 'Authenticate' });
    expect((await failure(smsService.sendOtp('+919876543210', '482913', 5))).code).toBe('SMS_PROVIDER_AUTH_FAILED');
    respond(400, { code: 21211, message: "Invalid 'To' Phone Number" });
    expect((await failure(smsService.sendOtp('+919876543210', '482913', 5))).code).toBe('SMS_DELIVERY_FAILED');
    respond(201, { sid: 'SM123', status: 'queued' });
    await expect(smsService.sendOtp('+919876543210', '482913', 5)).resolves.toBe('SM123');
  });

  it('sends through 2Factor with the number (no +), the code and an optional template', async () => {
    configure({ SMS_PROVIDER: '2factor', TWOFACTOR_API_KEY: 'key-123', TWOFACTOR_TEMPLATE_NAME: undefined });
    respond(200, { Status: 'Success', Details: 'session-1' });
    await expect(smsService.sendOtp('+919876543210', '482913', 5)).resolves.toBe('session-1');
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://2factor.in/API/V1/key-123/SMS/919876543210/482913');
    expect(init.method).toBe('GET');

    configure({ SMS_PROVIDER: '2factor', TWOFACTOR_API_KEY: 'key-123', TWOFACTOR_TEMPLATE_NAME: 'TimeFlowOTP' });
    respond(200, { Status: 'Success', Details: 'session-2' });
    await smsService.sendOtp('+919876543210', '482913', 5);
    expect((vi.mocked(fetch).mock.calls[0] as [string])[0]).toBe('https://2factor.in/API/V1/key-123/SMS/919876543210/482913/TimeFlowOTP');
  });

  it('maps 2Factor failures: bad key, rejection, and a missing key', async () => {
    configure({ SMS_PROVIDER: '2factor', TWOFACTOR_API_KEY: 'bad' });
    respond(400, { Status: 'Error', Details: 'Invalid API Key' });
    expect((await failure(smsService.sendOtp('+919876543210', '482913', 5))).code).toBe('SMS_PROVIDER_AUTH_FAILED');
    respond(200, { Status: 'Error', Details: 'Insufficient balance' });
    expect((await failure(smsService.sendOtp('+919876543210', '482913', 5))).code).toBe('SMS_DELIVERY_FAILED');
    configure({ SMS_PROVIDER: '2factor', TWOFACTOR_API_KEY: undefined });
    expect((await failure(smsService.sendOtp('+919876543210', '482913', 5))).code).toBe('SMS_NOT_CONFIGURED');
  });
});
