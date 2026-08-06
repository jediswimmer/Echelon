import { RouteApp, RouteContext } from './types';
import { registerHealthRoutes } from './health-routes';
import { registerHooksRoutes } from './hooks-routes';
import { registerAgentRoutes } from './agent-routes';
import { registerTelegramRoutes } from './telegram-routes';
import { registerSlackRoutes } from './slack-routes';
import { registerKanbanRoutes } from './kanban-routes';
import { registerSchedulerRoutes } from './scheduler-routes';
import { registerVaultRoutes } from './vault-routes';
import { registerSeasonRoutes } from './season-routes';

export function registerAllRoutes(app: RouteApp, ctx: RouteContext): void {
  registerHealthRoutes(app, ctx);
  registerHooksRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerTelegramRoutes(app, ctx);
  registerSlackRoutes(app, ctx);
  registerKanbanRoutes(app, ctx);
  registerSchedulerRoutes(app, ctx);
  registerVaultRoutes(app, ctx);
  registerSeasonRoutes(app, ctx);
}

export type { RouteApp, RouteContext, RouteRequest, SendJson, RouteHandler, RouteDefinition } from './types';
