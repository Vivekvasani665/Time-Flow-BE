import { env, isProd } from '../config/env';
import { logger } from '../lib/logger';

/** `to` is E.164, e.g. +919876543210. `vars` fill a DLT template (MSG91); `body` is the plain text (Twilio, log). */
export type SmsMessage = { to: string; body: string; vars?: { otp: string; minutes: number } };

/**
 * Why a message did not go out. Safe to show a client: it names the kind of
 * failure, never the provider's raw reply (that stays in the server log).
 */
export type SmsFailureCode =
  | 'INVALID_PHONE_NUMBER'
  | 'SMS_NOT_CONFIGURED'
  | 'SMS_BLOCKED_IN_DEVELOPMENT'
  | 'SMS_PROVIDER_AUTH_FAILED'
  | 'SMS_PROVIDER_UNAVAILABLE'
  | 'SMS_DELIVERY_FAILED';

export class SmsError extends Error {
  constructor(
    readonly code: SmsFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'SmsError';
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

/** Last 4 digits only — enough to match a log line to a signup without logging the number. */
const tail = (to: string) => `…${to.slice(-4)}`;

function providerFailure(provider: string, status: number, detail: string): SmsError {
  logger.error({ provider, httpStatus: status, detail }, '[SMS] provider response: rejected');
  if (status === 401 || status === 403) return new SmsError('SMS_PROVIDER_AUTH_FAILED', `${provider} rejected the credentials (${status})`);
  if (status >= 500) return new SmsError('SMS_PROVIDER_UNAVAILABLE', `${provider} is unavailable (${status}): ${detail}`);
  return new SmsError('SMS_DELIVERY_FAILED', `${provider} rejected the message (${status}): ${detail}`);
}

async function post(provider: string, url: string, init: RequestInit & { method?: string }): Promise<{ status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: 'POST', ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ provider, reason }, '[SMS] provider could not be reached');
    throw new SmsError('SMS_PROVIDER_UNAVAILABLE', `${provider} could not be reached: ${reason}`);
  }
}

async function twilio(message: SmsMessage): Promise<string> {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = env;
  if (!sid || !token || !from) throw new SmsError('SMS_NOT_CONFIGURED', 'SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM');

  const form = new URLSearchParams({ To: message.to, Body: message.body });
  // A Messaging Service SID picks its own sender; anything else is a phone number.
  form.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);

  const { status, data } = await post('twilio', `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (status >= 300) throw providerFailure('twilio', status, `${data.code ?? ''} ${data.message ?? 'no detail'}`.trim());
  logger.info({ provider: 'twilio', httpStatus: status, messageId: data.sid, providerStatus: data.status }, '[SMS] provider response: accepted');
  return String(data.sid ?? 'twilio');
}

/**
 * MSG91 Flow API. Indian DLT rules only allow pre-approved templates, so the
 * text is the template's, filled from `vars` — `body` is not sent.
 */
async function msg91(message: SmsMessage): Promise<string> {
  const { MSG91_AUTH_KEY: authKey, MSG91_TEMPLATE_ID: templateId, MSG91_SENDER_ID: sender } = env;
  if (!authKey || !templateId) throw new SmsError('SMS_NOT_CONFIGURED', 'SMS_PROVIDER=msg91 needs MSG91_AUTH_KEY (SMS_API_KEY) and MSG91_TEMPLATE_ID (SMS_TEMPLATE_ID)');

  const { status, data } = await post('msg91', 'https://control.msg91.com/api/v5/flow', {
    headers: { authkey: authKey, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      template_id: templateId,
      ...(sender ? { sender } : {}),
      short_url: '0',
      // MSG91 wants the number without the leading +.
      recipients: [{ mobiles: message.to.replace(/^\+/, ''), otp: message.vars?.otp, minutes: String(message.vars?.minutes ?? '') }],
    }),
  });
  // MSG91 answers 200 with {"type":"error"} for most failures, including a bad auth key.
  const detail = String(data.message ?? 'no detail');
  if (status >= 300 || data.type === 'error') throw providerFailure('msg91', /auth/i.test(detail) && status < 300 ? 401 : status, detail);
  logger.info({ provider: 'msg91', httpStatus: status, requestId: data.message }, '[SMS] provider response: accepted');
  return detail;
}

/**
 * 2Factor.in OTP SMS: GET /API/V1/{key}/SMS/{number}/{otp}[/{template}].
 * The message text is 2Factor's DLT-approved OTP template, so `body` is not
 * sent. Replies {"Status":"Success","Details":"<session id>"}; an unknown key
 * is HTTP 400 with Details "Invalid API Key".
 */
async function twoFactor(message: SmsMessage): Promise<string> {
  const { TWOFACTOR_API_KEY: apiKey, TWOFACTOR_TEMPLATE_NAME: template } = env;
  if (!apiKey) throw new SmsError('SMS_NOT_CONFIGURED', 'SMS_PROVIDER=2factor needs TWOFACTOR_API_KEY');
  const otp = message.vars?.otp;
  if (!otp) throw new SmsError('SMS_DELIVERY_FAILED', '2factor only sends OTP messages');

  // The key is part of the URL, so the URL itself is never logged.
  const path = [apiKey, 'SMS', message.to.replace(/^\+/, ''), otp, ...(template ? [template] : [])].map(encodeURIComponent).join('/');
  const { status, data } = await post('2factor', `https://2factor.in/API/V1/${path}`, { method: 'GET' });
  const detail = String(data.Details ?? 'no detail');
  if (status >= 300 || data.Status !== 'Success') throw providerFailure('2factor', /api key/i.test(detail) ? 401 : status >= 300 ? status : 400, detail);
  logger.info({ provider: '2factor', httpStatus: status, sessionId: detail }, '[SMS] provider response: accepted');
  return detail;
}

export const smsService = {
  /** Sends one SMS through SMS_PROVIDER and returns the provider's message id. Throws SmsError. */
  async sendMessage(message: SmsMessage): Promise<string> {
    logger.info({ provider: env.SMS_PROVIDER, to: tail(message.to) }, '[SMS] OTP sending');
    if (env.SMS_PROVIDER === 'log') {
      // Nothing leaves the machine. Outside production the text is logged so a
      // developer without an SMS account can still read the code.
      logger.warn({ to: tail(message.to), ...(isProd ? {} : { body: message.body }) }, '[SMS] not sent — SMS_PROVIDER=log, no SMS provider configured');
      throw new SmsError('SMS_NOT_CONFIGURED', 'No SMS provider is configured (SMS_PROVIDER=log)');
    }
    if (!isProd && !env.SMS_ALLOW_REAL_SEND) {
      logger.warn({ provider: env.SMS_PROVIDER }, '[SMS] not sent — set SMS_ALLOW_REAL_SEND=true to text real phones outside production');
      throw new SmsError('SMS_BLOCKED_IN_DEVELOPMENT', `SMS_PROVIDER=${env.SMS_PROVIDER} reaches real phones; set SMS_ALLOW_REAL_SEND=true to allow it outside production`);
    }
    if (env.SMS_PROVIDER === 'twilio') return twilio(message);
    if (env.SMS_PROVIDER === '2factor') return twoFactor(message);
    return msg91(message);
  },

  /** The OTP text for Twilio/log; MSG91 uses its DLT template with the same values. */
  sendOtp(to: string, otp: string, minutes: number): Promise<string> {
    return smsService.sendMessage({
      to,
      body: `Your TimeFlow verification code is ${otp}. It will expire in ${minutes} minutes. Do not share it with anyone.`,
      vars: { otp, minutes },
    });
  },
};
