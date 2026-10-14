import { CATEGORIES, PRIORITIES, REQUEST_STATUSES, ASSIGNMENT_STATUSES } from '../models/common';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{24}$' } };
const idemHeader = (required: boolean) => ({
  name: 'Idempotency-Key',
  in: 'header',
  required,
  description:
    'Unique key (8-128 chars) per logical operation. Retries with the same key and body replay the original 2xx response; ' +
    'same key with a different body returns 422; a concurrent duplicate returns 409.',
  schema: { type: 'string', minLength: 8, maxLength: 128 },
});

const errors = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((c) => [
      String(c),
      {
        description:
          {
            400: 'Validation error',
            401: 'Missing or invalid token',
            403: 'Role not permitted',
            404: 'Not found',
            409: 'State conflict (INVALID_STATE, AGENT_UNAVAILABLE, ALREADY_ASSIGNED, REQUEST_LOCKED, IDEMPOTENCY_IN_PROGRESS, ...)',
            422: 'Idempotency key reused with a different payload',
          }[c] ?? 'Error',
        content: json(ref('Error')),
      },
    ]),
  );

const ok = (description: string, schema: object) => ({ description, content: json(schema) });

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Real-Time Dispatch & Resource Allocation API',
    version: '1.0.0',
    description:
      'Accepts service requests, ranks and assigns available agents, and tracks the assignment lifecycle with ' +
      'concurrency-safe state transitions. Real-time events are delivered over Socket.IO (see README).\n\n' +
      '**Demo accounts** (password in README): admin@dispatch.test, dispatcher@dispatch.test, agent1..8@dispatch.test.',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'INVALID_STATE' },
              message: { type: 'string' },
              details: {},
              requestId: { type: 'string' },
            },
          },
        },
      },
      LatLng: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: { lat: { type: 'number', example: 12.9716 }, lng: { type: 'number', example: 77.5946 } },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'dispatcher', 'agent'] },
          agent: { type: 'string', nullable: true },
        },
      },
      Agent: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          skills: { type: 'array', items: { type: 'string', enum: CATEGORIES } },
          status: { type: 'string', enum: ['online', 'offline'] },
          available: { type: 'boolean' },
          location: ref('LatLng'),
          activeCount: { type: 'integer' },
          maxConcurrent: { type: 'integer' },
          lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
          stats: { type: 'object', additionalProperties: { type: 'integer' } },
        },
      },
      ServiceRequest: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          code: { type: 'string', example: 'REQ-1001' },
          title: { type: 'string' },
          description: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          priority: { type: 'string', enum: PRIORITIES },
          status: { type: 'string', enum: REQUEST_STATUSES },
          location: ref('LatLng'),
          address: { type: 'string' },
          assignedAgent: { type: 'string', nullable: true },
          assignedAgentName: { type: 'string', nullable: true },
          currentAssignment: { type: 'string', nullable: true },
          attempts: { type: 'integer' },
          triedAgents: { type: 'array', items: { type: 'string' } },
          failureReason: { type: 'string', nullable: true },
          cancelReason: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Assignment: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          request: { type: 'string' },
          agent: { type: 'string' },
          agentName: { type: 'string' },
          status: { type: 'string', enum: ASSIGNMENT_STATUSES },
          active: { type: 'boolean' },
          mode: { type: 'string', enum: ['auto', 'manual'] },
          score: { type: 'number', nullable: true },
          distanceKm: { type: 'number', nullable: true },
          offeredAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          endReason: { type: 'string', nullable: true },
        },
      },
      DispatchOutcome: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['offered', 'waiting', 'failed', 'queued', 'skipped'] },
          assignment: ref('Assignment'),
          candidates: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
      Candidate: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          name: { type: 'string' },
          distanceKm: { type: 'number' },
          activeCount: { type: 'integer' },
          maxConcurrent: { type: 'integer' },
          score: {
            type: 'object',
            properties: {
              distance: { type: 'number' },
              workload: { type: 'number' },
              fairness: { type: 'number' },
              total: { type: 'number' },
            },
          },
        },
      },
      DispatchConfig: {
        type: 'object',
        properties: {
          autoDispatch: { type: 'boolean' },
          maxRadiusKm: { type: 'number' },
          candidateLimit: { type: 'integer' },
          maxAttempts: { type: 'integer' },
          maxPendingSec: { type: 'integer' },
          weights: {
            type: 'object',
            properties: { distance: { type: 'number' }, workload: { type: 'number' }, fairness: { type: 'number' } },
          },
          priorityRules: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: { radiusMultiplier: { type: 'number' }, offerTimeoutSec: { type: 'integer' } },
            },
          },
        },
      },
      AuditLog: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string', example: 'assignment.offered' },
          entityType: { type: 'string' },
          entityId: { type: 'string' },
          request: { type: 'string', nullable: true },
          actor: {
            type: 'object',
            properties: { id: { type: 'string', nullable: true }, role: { type: 'string' }, name: { type: 'string' } },
          },
          from: { type: 'string', nullable: true },
          to: { type: 'string', nullable: true },
          meta: { type: 'object' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Auth' },
    { name: 'Requests', description: 'Admin + Dispatcher' },
    { name: 'Assignments', description: 'Agent only (own assignments)' },
    { name: 'Agents' },
    { name: 'Config', description: 'Dispatch rules' },
    { name: 'Audit & Dashboard' },
    { name: 'System' },
  ],
  paths: {
    '/health': { get: { tags: ['System'], security: [], summary: 'Liveness', responses: { 200: { description: 'OK' } } } },
    '/ready': {
      get: { tags: ['System'], security: [], summary: 'Readiness (Mongo + Redis)', responses: { 200: { description: 'Ready' }, 503: { description: 'Not ready' } } },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        security: [],
        summary: 'Exchange email/password for a JWT',
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['email', 'password'],
            properties: { email: { type: 'string', example: 'dispatcher@dispatch.test' }, password: { type: 'string', example: 'Dispatch@12345' } },
          }),
        },
        responses: {
          200: ok('Token issued', { type: 'object', properties: { token: { type: 'string' }, user: ref('User') } }),
          ...errors(400, 401),
        },
      },
    },
    '/auth/me': { get: { tags: ['Auth'], summary: 'Current user', responses: { 200: ok('User', { type: 'object', properties: { user: ref('User') } }), ...errors(401) } } },
    '/users': {
      get: { tags: ['Auth'], summary: 'List users (admin)', responses: { 200: { description: 'Users' }, ...errors(401, 403) } },
      post: {
        tags: ['Auth'],
        summary: 'Create user (admin). Agent users require an `agent` profile.',
        parameters: [idemHeader(false)],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['name', 'email', 'password', 'role'],
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
              password: { type: 'string', minLength: 8 },
              role: { type: 'string', enum: ['admin', 'dispatcher', 'agent'] },
              agent: {
                type: 'object',
                properties: {
                  skills: { type: 'array', items: { type: 'string', enum: CATEGORIES } },
                  location: ref('LatLng'),
                  maxConcurrent: { type: 'integer', minimum: 1, maximum: 10 },
                },
              },
            },
          }),
        },
        responses: { 201: { description: 'Created' }, ...errors(400, 401, 403, 409) },
      },
    },
    '/requests': {
      post: {
        tags: ['Requests'],
        summary: 'Create a service request (auto-dispatches when enabled)',
        parameters: [idemHeader(true)],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['title', 'category', 'location'],
            properties: {
              title: { type: 'string', example: 'AC not cooling' },
              description: { type: 'string' },
              category: { type: 'string', enum: CATEGORIES },
              priority: { type: 'string', enum: PRIORITIES, default: 'normal' },
              location: ref('LatLng'),
              address: { type: 'string' },
            },
          }),
        },
        responses: {
          201: ok('Created', { type: 'object', properties: { request: ref('ServiceRequest'), dispatch: ref('DispatchOutcome') } }),
          ...errors(400, 401, 403, 409, 422),
        },
      },
      get: {
        tags: ['Requests'],
        summary: 'List requests (sorted by priority, newest first)',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Comma-separated, e.g. pending,offered' },
          { name: 'priority', in: 'query', schema: { type: 'string', enum: PRIORITIES } },
          { name: 'category', in: 'query', schema: { type: 'string', enum: CATEGORIES } },
          { name: 'agentId', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
        ],
        responses: {
          200: ok('Page of requests', {
            type: 'object',
            properties: { data: { type: 'array', items: ref('ServiceRequest') }, page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' } },
          }),
          ...errors(400, 401, 403),
        },
      },
    },
    '/requests/{id}': {
      get: {
        tags: ['Requests'],
        summary: 'Request detail with assignment history (agents: only requests offered to them)',
        parameters: [idParam],
        responses: {
          200: ok('Detail', { type: 'object', properties: { request: ref('ServiceRequest'), assignments: { type: 'array', items: ref('Assignment') } } }),
          ...errors(401, 403, 404),
        },
      },
      patch: {
        tags: ['Requests'],
        summary: 'Edit a pending request (title, description, priority, address)',
        parameters: [idParam],
        requestBody: { required: true, content: json({ type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: PRIORITIES }, address: { type: 'string' } } }) },
        responses: { 200: { description: 'Updated' }, ...errors(400, 401, 403, 404, 409) },
      },
    },
    '/requests/{id}/candidates': {
      get: {
        tags: ['Requests'],
        summary: 'Preview ranked candidate agents with score breakdown (no side effects)',
        parameters: [idParam],
        responses: {
          200: ok('Candidates', { type: 'object', properties: { radiusKm: { type: 'number' }, candidates: { type: 'array', items: ref('Candidate') } } }),
          ...errors(401, 403, 404),
        },
      },
    },
    '/requests/{id}/dispatch': {
      post: {
        tags: ['Requests'],
        summary: 'Run auto-dispatch now (best-scoring available agent)',
        parameters: [idParam, idemHeader(false)],
        responses: {
          200: ok('Outcome', { type: 'object', properties: { request: ref('ServiceRequest'), dispatch: ref('DispatchOutcome') } }),
          ...errors(401, 403, 404, 409),
        },
      },
    },
    '/requests/{id}/assign': {
      post: {
        tags: ['Requests'],
        summary: 'Manually offer a pending request to a specific agent',
        parameters: [idParam, idemHeader(true)],
        requestBody: { required: true, content: json({ type: 'object', required: ['agentId'], properties: { agentId: { type: 'string' } } }) },
        responses: {
          201: ok('Offered', { type: 'object', properties: { request: ref('ServiceRequest'), assignment: ref('Assignment') } }),
          ...errors(400, 401, 403, 404, 409, 422),
        },
      },
    },
    '/requests/{id}/reassign': {
      post: {
        tags: ['Requests'],
        summary: 'Revoke the current offer/acceptance and assign to another agent (or auto-dispatch)',
        parameters: [idParam, idemHeader(true)],
        requestBody: { content: json({ type: 'object', properties: { agentId: { type: 'string' }, reason: { type: 'string' } } }) },
        responses: { 200: { description: 'Reassigned' }, ...errors(400, 401, 403, 404, 409, 422) },
      },
    },
    '/requests/{id}/cancel': {
      post: {
        tags: ['Requests'],
        summary: 'Cancel a request and release its agent (repeat calls are no-ops)',
        parameters: [idParam, idemHeader(false)],
        requestBody: { required: true, content: json({ type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } }) },
        responses: { 200: { description: 'Cancelled' }, ...errors(400, 401, 403, 404, 409) },
      },
    },
    ...Object.fromEntries(
      (['accept', 'start', 'complete'] as const).map((step) => [
        `/assignments/{id}/${step}`,
        {
          post: {
            tags: ['Assignments'],
            summary: {
              accept: 'Accept an offer (fails with OFFER_EXPIRED after the timeout)',
              start: 'Start an accepted job',
              complete: 'Complete an in-progress job (frees agent capacity)',
            }[step],
            description: 'Naturally idempotent: repeating a step that already happened returns `replayed: true`.',
            parameters: [idParam],
            responses: {
              200: ok('Updated', { type: 'object', properties: { assignment: ref('Assignment'), request: ref('ServiceRequest'), replayed: { type: 'boolean' } } }),
              ...errors(401, 403, 404, 409),
            },
          },
        },
      ]),
    ),
    '/assignments/{id}/reject': {
      post: {
        tags: ['Assignments'],
        summary: 'Reject an offer; the request is re-dispatched to the next best agent immediately',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { reason: { type: 'string' } } }) },
        responses: { 200: { description: 'Rejected' }, ...errors(401, 403, 404, 409) },
      },
    },
    '/agents': {
      get: {
        tags: ['Agents'],
        summary: 'List agents',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['online', 'offline'] } },
          { name: 'available', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'skill', in: 'query', schema: { type: 'string', enum: CATEGORIES } },
        ],
        responses: { 200: ok('Agents', { type: 'object', properties: { data: { type: 'array', items: ref('Agent') } } }), ...errors(401, 403) },
      },
    },
    '/agents/{id}': {
      get: { tags: ['Agents'], summary: 'Agent detail', parameters: [idParam], responses: { 200: { description: 'Agent' }, ...errors(401, 403, 404) } },
      patch: {
        tags: ['Agents'],
        summary: 'Update agent skills/capacity (admin)',
        parameters: [idParam],
        requestBody: { content: json({ type: 'object', properties: { name: { type: 'string' }, skills: { type: 'array', items: { type: 'string', enum: CATEGORIES } }, maxConcurrent: { type: 'integer' } } }) },
        responses: { 200: { description: 'Updated' }, ...errors(400, 401, 403, 404) },
      },
    },
    '/agents/me': { get: { tags: ['Agents'], summary: 'Own agent profile (agent)', responses: { 200: { description: 'Agent' }, ...errors(401, 403) } } },
    '/agents/me/status': {
      post: {
        tags: ['Agents'],
        summary: 'Go online/offline. Going offline re-queues offered/accepted work.',
        requestBody: { required: true, content: json({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['online', 'offline'] }, location: ref('LatLng') } }) },
        responses: { 200: { description: 'Status updated' }, ...errors(400, 401, 403) },
      },
    },
    '/agents/me/heartbeat': {
      post: {
        tags: ['Agents'],
        summary: 'REST heartbeat (Socket.IO `agent:heartbeat` is preferred). Keeps the agent online.',
        requestBody: { content: json({ type: 'object', properties: { location: ref('LatLng') } }) },
        responses: { 200: { description: 'OK' }, ...errors(400, 401, 403) },
      },
    },
    '/agents/me/assignments': {
      get: {
        tags: ['Agents'],
        summary: 'Own assignments (active by default; ?active=false for history)',
        parameters: [{ name: 'active', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }],
        responses: { 200: { description: 'Assignments' }, ...errors(401, 403) },
      },
    },
    '/config/dispatch': {
      get: { tags: ['Config'], summary: 'Current dispatch rules', responses: { 200: ok('Config', { type: 'object', properties: { config: ref('DispatchConfig') } }), ...errors(401, 403) } },
      put: {
        tags: ['Config'],
        summary: 'Partially update dispatch rules (admin)',
        requestBody: { required: true, content: json(ref('DispatchConfig')) },
        responses: { 200: { description: 'Updated' }, ...errors(400, 401, 403) },
      },
    },
    '/audit': {
      get: {
        tags: ['Audit & Dashboard'],
        summary: 'Audit trail (newest first)',
        parameters: [
          { name: 'requestId', in: 'query', schema: { type: 'string' } },
          { name: 'entityId', in: 'query', schema: { type: 'string' } },
          { name: 'action', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { 200: ok('Entries', { type: 'object', properties: { data: { type: 'array', items: ref('AuditLog') } } }), ...errors(401, 403) },
      },
    },
    '/dashboard/summary': {
      get: { tags: ['Audit & Dashboard'], summary: 'Counters for the dashboard', responses: { 200: { description: 'Summary' }, ...errors(401, 403) } },
    },
  },
};
