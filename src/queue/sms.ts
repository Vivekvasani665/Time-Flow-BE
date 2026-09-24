import { env, isProd } from '../config/env';
import { logger } from '../lib/logger';

/** `to` is E.164, e.g. +919876543210. */
export type SmsMessage = { to: string; body: string; vars?: { otp: string; minutes: number } };

/** Refused before it left the building — retrying would not change the outcome. */
export class BlockedSmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedSmsError';
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

async function twilio(message: SmsMessage): Promise<string> {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = env;
  if (!sid || !token || !from) throw new Error('SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM');

  const form = new URLSearchParams({ To: message.to, Body: message.body });
  // A Messaging Service SID picks its own sender; anything else is a phone number.
  form.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok) throw new Error(`Twilio rejected the message (${res.status}${data.code ? ` / ${data.code}` : ''}): ${data.message ?? 'no detail'}`);
  return data.sid ?? 'twilio';
}

/**
 * MSG91 Flow API. Indian DLT rules only allow pre-approved templates, so the
 * text is the template's, filled from `vars` — `body` is not sent.
 */
async function msg91(message: SmsMessage): Promise<string> {
  const { MSG91_AUTH_KEY: authKey, MSG91_TEMPLATE_ID: templateId } = env;
  if (!authKey || !templateId) throw new Error('SMS_PROVIDER=msg91 needs MSG91_AUTH_KEY and MSG91_TEMPLATE_ID');

  const res = await fetch('https://control.msg91.com/api/v5/flow', {
    method: 'POST',
    headers: { authkey: authKey, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      template_id: templateId,
      short_url: '0',
      // MSG91 wants the number without the leading +.
      recipients: [{ mobiles: message.to.replace(/^\+/, ''), otp: message.vars?.otp, minutes: String(message.vars?.minutes ?? '') }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
  if (!res.ok || data.type === 'error') throw new Error(`MSG91 rejected the message (${res.status}): ${data.message ?? 'no detail'}`);
  return data.message ?? 'msg91';
}

/** Sends one SMS through SMS_PROVIDER. Returns the provider's message id. */
export async function sendSms(message: SmsMessage): Promise<string> {
  if (env.SMS_PROVIDER === 'log') {
    // Nothing leaves the machine. Outside production the text is logged so a
    // developer without an SMS account can still read the code.
    logger.info({ to: message.to, ...(isProd ? {} : { body: message.body }) }, 'sms logged (no SMS provider configured)');
    return 'log-only';
  }
  if (!isProd && !env.SMS_ALLOW_REAL_SEND) {
    throw new BlockedSmsError(`SMS_PROVIDER=${env.SMS_PROVIDER} reaches real phones; set SMS_ALLOW_REAL_SEND=true to allow it outside production`);
  }
  return env.SMS_PROVIDER === 'twilio' ? twilio(message) : msg91(message);
}
