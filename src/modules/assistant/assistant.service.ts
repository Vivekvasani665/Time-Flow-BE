import Groq from 'groq-sdk';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'groq-sdk/resources/chat/completions';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { redis } from '../../lib/redis';
import { SlidingWindowRateLimiter } from '../../cache/rate-limiter';
import { AppError, RateLimitError } from '../../common/errors';
import { fullName, type RequestContext } from '../../common/utils/request-context';
import type { AuthContext } from '../auth/auth.types';
import { assistantTools, TOOL_STATUS, type AssistantTool } from './assistant.tools';

export const ASSISTANT_NAME = 'TimeFlow Assistant';
const MAX_TOOL_ROUNDS = 6;
export const ASSISTANT_DISABLED_MESSAGE = "The assistant isn't set up yet. Ask an administrator to add a Groq API key.";

/** The conversation, kept by the client and sent whole each turn (nothing is stored server-side). */
export const assistantChatSchema = z
  .object({
    messages: z
      .array(
        z.discriminatedUnion('role', [
          z.object({ role: z.literal('user'), content: z.string().trim().min(1).max(4000, 'Please keep your message under 4000 characters.') }).strict(),
          // The assistant's own earlier replies come back with the history and can be long.
          z.object({ role: z.literal('assistant'), content: z.string().trim().min(1).max(20000) }).strict(),
        ]),
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

const client = env.GROQ_API_KEY ? new Groq({ apiKey: env.GROQ_API_KEY }) : null;
const limiter = new SlidingWindowRateLimiter(redis, 'assistant', env.RATE_LIMIT_ASSISTANT_MAX, env.RATE_LIMIT_ASSISTANT_WINDOW_SECONDS * 1000);

function systemPrompt(actor: AuthContext): string {
  return [
    `You are ${ASSISTANT_NAME}, the assistant built into TimeFlow, a team project and task management app.`,
    `You are talking with ${fullName(actor)} (role: ${actor.roleName}).`,
    'You help with work: TimeFlow projects and tasks, planning, writing (emails, messages, task descriptions, summaries), explanations and general questions, and translation between any languages.',
    'You do not do programming. Do not write, explain, review or debug code, scripts, queries or formulas in any language, even small snippets. If asked, say briefly that coding is outside what you do here and offer the kinds of help you can give.',
    'For questions about TimeFlow data (projects, tasks, deadlines, workload, dashboard numbers), use the tools to look up real data before answering, and never invent tasks, projects, people, ids or numbers. If a tool reports an error or missing permission, tell the user plainly. Do not call tools for questions that have nothing to do with TimeFlow.',
    [
      'You can create and assign tasks with create_tasks and assign_task. Work out the project with list_projects (and people with list_project_members) instead of asking for ids.',
      'If the user does not name an assignee, or asks you to pick, use automatic assignment (the least busy project member). "Everyone" / "all users" / "all members" means one copy of the task for each member of the project.',
      'If the project is unclear and more than one could fit, ask which one, listing the likely choices. If the title is missing, ask for it. Otherwise act straight away without asking for confirmation, except that before creating more than 5 tasks at once you first say how many and for whom and wait for a yes.',
      'After acting, confirm what was done: each task title with who it went to, plus anything that failed and why.',
      'You cannot delete tasks, edit projects or manage users; point the user to the Tasks or Projects page for those. You cannot see the screen, so do not describe specific buttons or menus.',
    ].join(' '),
    'Translation: when asked to translate, give the translation directly (keeping names, dates and formatting), with a short note only when a phrase is ambiguous. Task titles and descriptions are saved exactly as the user wants them; translate them only when asked.',
    'Always reply in the language and script the user writes in (for example Hindi, Gujarati, or Hinglish in Latin letters), unless they ask for another. Replies are rendered as Markdown: use short lists, tables and **bold** where they help, and keep answers as short as the question allows.',
    `Today's date is ${new Date().toISOString().slice(0, 10)}. Resolve relative dates like "tomorrow" or "next Friday" from it when setting due dates.`,
  ].join('\n\n');
}

/** The tools in Groq's (OpenAI-style) function format; each schema comes from its Zod definition. */
function toGroqTools(tools: AssistantTool[]): ChatCompletionTool[] {
  return tools.map((t) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(t.inputSchema) as Record<string, unknown>;
    return { type: 'function', function: { name: t.name, description: t.description, parameters } };
  });
}

/**
 * Runs one requested tool call. The model's arguments are untrusted text:
 * parsed and validated against the tool's schema before anything runs, and
 * any problem goes back to the model as the result so it can correct itself.
 */
async function runTool(tools: AssistantTool[], name: string, rawArgs: string, userId: string): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
  let args: unknown;
  try {
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return JSON.stringify({ error: 'The arguments were not valid JSON.' });
  }
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) return JSON.stringify({ error: 'Invalid arguments', issues: parsed.error.issues.map((i) => i.message) });
  try {
    return await tool.run(parsed.data as never);
  } catch (err) {
    logger.error({ err, tool: name, userId }, 'assistant tool failed');
    return JSON.stringify({ error: 'That step failed. Tell the user to try again.' });
  }
}

type PendingCall = { id: string; name: string; args: string };

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
  async reply(ctx: RequestContext, input: AssistantChatInput, emit: (event: AssistantEvent) => void, signal: AbortSignal): Promise<void> {
    if (!client) throw new AppError(503, 'ASSISTANT_DISABLED', ASSISTANT_DISABLED_MESSAGE);

    const { actor } = ctx;
    const tools = assistantTools(ctx);
    const groqTools = toGroqTools(tools);
    const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt(actor) }, ...input.messages];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = await client.chat.completions.create(
        {
          model: env.ASSISTANT_MODEL,
          messages,
          tools: groqTools,
          tool_choice: 'auto',
          stream: true,
          max_completion_tokens: 8192,
          // Enough thought for real questions while staying quick. The reasoning itself is never sent back.
          reasoning_effort: 'medium',
          include_reasoning: false,
        },
        { signal },
      );

      let content = '';
      let finish: string | null = null;
      const calls: PendingCall[] = [];
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta.content) {
          content += choice.delta.content;
          emit({ type: 'delta', text: choice.delta.content });
        }
        // Tool calls arrive in pieces, keyed by index.
        for (const piece of choice.delta.tool_calls ?? []) {
          const call = (calls[piece.index] ??= { id: '', name: '', args: '' });
          if (piece.id) call.id = piece.id;
          if (piece.function?.name) call.name += piece.function.name;
          if (piece.function?.arguments) call.args += piece.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      const pending = calls.filter(Boolean);
      if (finish !== 'tool_calls' || pending.length === 0) {
        if (finish === 'length') emit({ type: 'error', message: 'That answer got too long and was cut off. Try asking for less at once.' });
        emit({ type: 'done' });
        return;
      }

      emit({ type: 'status', text: TOOL_STATUS[pending[0]!.name] ?? 'Looking that up…' });
      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: pending.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
      });
      const results = await Promise.all(pending.map((c) => runTool(tools, c.name, c.args, actor.id)));
      pending.forEach((c, i) => messages.push({ role: 'tool', tool_call_id: c.id, content: results[i]! }));
    }

    emit({ type: 'error', message: 'That needed too many lookups. Try a more specific question.' });
    emit({ type: 'done' });
  },
};
