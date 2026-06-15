import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { weatherWorkflow } from './workflows/weather-workflow';
import { prospectWorkflow } from './workflows/prospect-workflow';
import { weatherAgent } from './agents/weather-agent';
import { outreachAgent } from './agents/outreach-agent';
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';
import { apiRoutes } from './server/routes';
import { initJobStore } from './research/job-store';
import { initChatStore } from './research/chat-store';

// Ensure the custom libsql tables exist on boot. (The stores also lazily
// self-init on first use, so this is belt-and-suspenders, not load-bearing.)
void initJobStore();
void initChatStore();

export const mastra = new Mastra({
  workflows: { weatherWorkflow, prospectWorkflow },
  agents: { weatherAgent, outreachAgent },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer },
  storage: new LibSQLStore({
    id: 'mastra-storage',
    // stores observability, scores, ... into persistent file storage
    url: 'file:./mastra.db',
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  server: {
    apiRoutes,
  },
});
