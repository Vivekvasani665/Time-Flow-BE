import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { redis } from '../../lib/redis';
import { SlidingWindowRateLimiter } from '../../cache/rate-limiter';
import { AppError, RateLimitError } from '../../common/errors';
import { fullName } from '../../common/utils/request-context';
import type { AuthContext } from '../auth/auth.types';
import { assistantTools, TOOL_STATUS } from './assistant.tools';

export const ASSISTANT_NAME = 'TimeFlow Assistant';
const MAX_TOOL_ROUNDS = 6;

/** The conversation, kept by the client and sent whole each turn (nothing is stored server-side). */
export const assistantChatSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().trim().min(1).max(4000, 'Please keep your message under 4000 characters.'),
          })
          .strict(),
      )
      .min(1)
      .max(40, 'This conversation is too long. Start a new one to keep going.')
      .refine((m) => m.at(-1)?.role === 'user', 'The last message must be from you'),
  })
  .strict();

export type AssistantChatInput = z.infer<typeof assistantChatSchema>;

/** What the route streams to the browser. */
export type AssistantEvent =
  | { type: 'delta'; text: string }
  | { type: 'status'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

const client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
const limiter = new SlidingWindowRateLimiter(redis, 'assistant', env.RATE_LIMIT_ASSISTANT_MAX, env.RATE_LIMIT_ASSISTANT_WINDOW_SECONDS * 1000);

function systemPrompt(actor: AuthContext): string {
  return [
    `You are ${ASSISTANT_NAME}, the assistant built into TimeFlow, a team project and task management app.`,
    `You are talking with ${fullName(actor)} (role: ${actor.roleName}).`,
    'Help with their projects, tasks, deadlines and workload. Use the tools to look up real data before answering questions about it, and never invent tasks, projects, people or numbers. If a tool says the user lacks permission, tell them so.',
    'You can read data but not change it. If asked to create, edit, assign or delete something, explain where in TimeFlow they can do it (Projects or Tasks pages).',
    'Replies appear in a chat bubble that shows plain text: no Markdown headings, tables, bold or code blocks. Short paragraphs and simple "- " bullet lists are fine. Be concise and friendly.',
    `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
  ].join('\n\n');
}

export const assistantService = {
  enabled: () => client !== null,

  async assertWithinBudget(actor: AuthContext): Promise<void> {
    let decision;
    try {
      decision = await limiter.consume(actor.id);
    } catch (err) {
      logger.error({ err }, 'assistant rate limiter unavailable; allowing request');
      return;
    }
    if (!decision.allowed) {
      throw new RateLimitError(
        Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
        "You've asked the assistant a lot in a short time. Please wait a few minutes and try again.",
      );
    }
  },

  /** Runs one assistant turn, calling tools as needed, and reports progress through `emit`. */
  async reply(actor: AuthContext, input: AssistantChatInput, emit: (event: AssistantEvent) => void, signal: AbortSignal): Promise<void> {
    if (!client) throw new AppError(503, 'ASSISTANT_DISABLED', "The assistant isn't set up yet. Ask an administrator to add an Anthropic API key.");

    const runner = client.beta.messages.toolRunner(
      {
        model: env.ASSISTANT_MODEL,
        max_tokens: 16000,
        // Chat lookups don't need deep reasoning; low effort keeps replies quick and cheap.
        output_config: { effort: 'low' },
        system: systemPrompt(actor),
        tools: assistantTools(actor),
        messages: input.messages,
        max_iterations: MAX_TOOL_ROUNDS,
        stream: true,
        // If the model declines on a safety policy, the API retries on a fallback model within the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal },
    );

    let finalStop: string | null = null;
    for await (const stream of runner) {
      stream.on('text', (text) => emit({ type: 'delta', text }));
      const message = await stream.finalMessage();
      finalStop = message.stop_reason;
      if (message.stop_reason === 'tool_use') {
        const names = message.content.flatMap((b) => (b.type === 'tool_use' ? [b.name] : []));
        emit({ type: 'status', text: TOOL_STATUS[names[0] ?? ''] ?? 'Looking that up…' });
      }
    }

    if (finalStop === 'refusal') emit({ type: 'error', message: "I can't help with that request." });
    else if (finalStop === 'max_tokens') emit({ type: 'error', message: 'That answer got too long and was cut off. Try asking for less at once.' });
    else if (finalStop === 'tool_use') emit({ type: 'error', message: 'That needed too many lookups. Try a more specific question.' });
    emit({ type: 'done' });
  },
};
