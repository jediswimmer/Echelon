import { RouteApp, RouteContext } from './types';
import { requestExpansion } from '../../core/season-manager';

/**
 * Season routes a running agent can call back into (#19).
 *
 * POST /api/seasons/:id/request-expansion
 *   A cast agent that hit a gap ("we need a <role> for this") asks for a new
 *   teammate. The request is recorded `pending` on the season and surfaces on the
 *   control board for the user to approve/decline — this endpoint NEVER casts an
 *   agent itself (approval, which does the casting, happens in the renderer via
 *   IPC where the season runtime deps live). Body:
 *     { role: string, reason: string, archetype?: string, fromAgentId?: string }
 *   Returns { ok, requestId } on success. Resilient — bad input → 400, never a crash.
 */
export function registerSeasonRoutes(app: RouteApp, _ctx: RouteContext): void {
  // The :id capture is mapped to params.id by the server's matchRoute().
  app.post(/^\/api\/seasons\/([^/]+)\/request-expansion$/, async (req, sendJson) => {
    try {
      const seasonId = req.params.id;
      if (!seasonId) {
        sendJson({ ok: false, error: 'seasonId is required' }, 400);
        return;
      }

      const body = (req.body ?? {}) as {
        role?: unknown;
        reason?: unknown;
        archetype?: unknown;
        fromAgentId?: unknown;
      };

      const role = typeof body.role === 'string' ? body.role.trim() : '';
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      const archetype = typeof body.archetype === 'string' ? body.archetype.trim() : undefined;
      const fromAgentId = typeof body.fromAgentId === 'string' ? body.fromAgentId.trim() : undefined;

      if (!role && !archetype) {
        sendJson({ ok: false, error: 'role (or archetype) is required' }, 400);
        return;
      }
      if (!reason) {
        sendJson({ ok: false, error: 'reason is required' }, 400);
        return;
      }

      const request = requestExpansion(seasonId, {
        role: role || archetype || 'specialist',
        reason,
        archetype,
        requestedByAgentId: fromAgentId,
      });

      if (!request) {
        sendJson({ ok: false, error: 'Season not found' }, 404);
        return;
      }

      sendJson({ ok: true, requestId: request.id });
    } catch (err) {
      console.error('[Season] request-expansion failed:', err);
      sendJson({ ok: false, error: 'Failed to record expansion request' }, 500);
    }
  });
}
