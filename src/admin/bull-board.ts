import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { Router } from 'express';
import { getQueues } from '../queue/queues';

export const BULL_BOARD_PATH = '/admin/queues';

export function createBullBoardRouter(): Router {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);
  const { email, activity, emailDeadLetter } = getQueues();
  createBullBoard({
    queues: [new BullMQAdapter(email), new BullMQAdapter(activity), new BullMQAdapter(emailDeadLetter, { readOnlyMode: true })],
    serverAdapter,
    options: { uiConfig: { boardTitle: 'TimeFlow Queues' } },
  });
  return serverAdapter.getRouter() as Router;
}
