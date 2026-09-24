import { randomInt } from 'node:crypto';
import { AppError } from '../../common/errors';
import { logger } from '../../lib/logger';
import { sendMail, type MailMessage } from '../../queue/mailer';
import { SmsError, smsService } from '../../queue/sms';

/**
 * One code, many channels. Signup and sign-in both generate a single OTP and
 * hand it here to go out by email and SMS; whichever message arrives, the same
 * code verifies.
 */

/** The one OTP generator: uniform over 000000–999999 from the OS CSPRNG. */
export const generateOtp = () => randomInt(0, 1_000_000).toString().padStart(6, '0');

export type OtpChannel = 'email' | 'sms';
export const OTP_CHANNELS: readonly OtpChannel[] = ['email', 'sms'];

/**
 * Per-channel outcome of the latest send. A failure carries a safe code the
 * client can explain — never the provider's reply, which stays in the log.
 *   EMAIL_DELIVERY_FAILED, INVALID_PHONE_NUMBER, SMS_NOT_CONFIGURED,
 *   SMS_BLOCKED_IN_DEVELOPMENT, SMS_PROVIDER_AUTH_FAILED,
 *   SMS_PROVIDER_UNAVAILABLE, SMS_DELIVERY_FAILED
 */
export type ChannelDelivery = { status: 'sent' } | { status: 'failed'; code: string };
export type OtpDelivery = Partial<Record<OtpChannel, ChannelDelivery>>;

/** Summary fields every OTP challenge carries, so a client can say exactly where the code went. */
export type DeliverySummary = { channels: OtpChannel[]; delivery: OtpDelivery; emailSent: boolean; smsSent: boolean };

export const summarize = (delivered: OtpChannel[], delivery: OtpDelivery): DeliverySummary => ({
  channels: delivered,
  delivery,
  emailSent: delivery.email?.status === 'sent',
  smsSent: delivery.sms?.status === 'sent',
});

/**
 * A number an SMS provider accepts: E.164, `+` and 8–15 digits. Formatting
 * (spaces, dashes, brackets, dots) is dropped. A number saved without its
 * country code returns null — guessing one could text a stranger.
 */
export function normalizeMobile(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const compact = phone.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

/** `+919876543210` → `+91******3210`. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 6) return `+${'*'.repeat(digits.length)}`;
  return `+${digits.slice(0, 2)}${'*'.repeat(digits.length - 6)}${digits.slice(-4)}`;
}

type Recipient = { id: string; phone: string | null };

/**
 * Sends one code on each requested channel and reports each outcome. Throws
 * only when no channel got it; `noneDelivered` builds that error so each flow
 * keeps its own error code. Never logs or returns the code.
 */
export async function deliverOtp(opts: {
  user: Recipient;
  otp: string;
  minutes: number;
  channels: readonly OtpChannel[];
  email: MailMessage;
  purpose: 'signup' | 'login';
  noneDelivered: (delivery: OtpDelivery) => AppError;
}): Promise<DeliverySummary> {
  const { user, otp, minutes, purpose } = opts;
  const mobile = normalizeMobile(user.phone);

  const send = async (channel: OtpChannel): Promise<string> => {
    if (channel === 'sms') {
      if (!mobile) throw new SmsError('INVALID_PHONE_NUMBER', user.phone ? 'stored number has no valid country code' : 'account has no mobile number');
      return smsService.sendOtp(mobile, otp, minutes);
    }
    logger.info({ userId: user.id, purpose }, '[EMAIL] OTP sending');
    const messageId = await sendMail(opts.email);
    logger.info({ userId: user.id, purpose, messageId }, '[EMAIL] OTP result: accepted by the mail provider');
    return messageId;
  };

  const results = await Promise.allSettled(opts.channels.map(send));
  const delivered: OtpChannel[] = [];
  const delivery: OtpDelivery = {};
  results.forEach((r, i) => {
    const channel = opts.channels[i];
    if (r.status === 'fulfilled') {
      delivered.push(channel);
      delivery[channel] = { status: 'sent' };
      return;
    }
    const code = r.reason instanceof SmsError ? r.reason.code : channel === 'email' ? 'EMAIL_DELIVERY_FAILED' : 'SMS_DELIVERY_FAILED';
    delivery[channel] = { status: 'failed', code };
    logger.error(
      { userId: user.id, purpose, channel, code, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) },
      `[${channel === 'sms' ? 'SMS' : 'EMAIL'}] OTP result: not delivered`,
    );
  });
  if (delivered.length === 0) throw opts.noneDelivered(delivery);
  return summarize(delivered, delivery);
}

/** Error details for a 503: which channel failed and why, as safe codes. */
export const deliveryDetails = (delivery: OtpDelivery) =>
  Object.entries(delivery).map(([path, d]) => ({ path, message: d.status === 'failed' ? d.code : d.status }));

/** Channels to try for an account: SMS only when it has a mobile number at all. */
export const channelsFor = (user: Recipient, requested: readonly OtpChannel[] = OTP_CHANNELS): OtpChannel[] =>
  requested.filter((c) => c === 'email' || Boolean(user.phone));
