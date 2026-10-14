import { Types } from 'mongoose';
import { runSweepOnce } from '../src/jobs/sweeper';
import { redis } from '../src/infra/redis';
import { Agent } from '../src/models/Agent';
import { Assignment } from '../src/models/Assignment';
import { AuditLog } from '../src/models/AuditLog';
import { ServiceRequest } from '../src/models/ServiceRequest';
import { HEARTBEAT_KEY } from '../src/services/presence.service';
import {
  api,
  auth,
  createAgent,
  createPendingRequest,
  createStaff,
  idemKey,
  north,
  requestBody,
  setConfig,
  useTestEnv,
} from './helpers';

useTestEnv();

async function createViaApi(token: string, overrides: Record<string, unknown> = {}) {
  const res = await api()
    .post('/api/requests')
    .set(auth(token))
    .set('Idempotency-Key', idemKey())
    .send(requestBody(overrides));
  expect(res.status).toBe(201);
  return res.body as { request: { id: string; status: string; assignedAgent: string | null }; dispatch: any };
}

describe('auto-dispatch selection', () => {
  it('offers a new request to the nearest available agent with the right skill', async () => {
    const { token } = await createStaff();
    const far = await createAgent({ name: 'Far', location: north(6), skills: ['repair'] });
    const near = await createAgent({ name: 'Near', location: north(1), skills: ['repair'] });
    await createAgent({ name: 'Nearest but wrong skill', location: north(0.1), skills: ['medical'] });
    await createAgent({ name: 'Nearest but offline', location: north(0.2), skills: ['repair'], online: false });

    const { request, dispatch } = await createViaApi(token);

    expect(dispatch.outcome).toBe('offered');
    expect(request.status).toBe('offered');
    expect(request.assignedAgent).toBe(near.agentId);
    expect(request.assignedAgent).not.toBe(far.agentId);
    expect(dispatch.assignment.mode).toBe('auto');
    expect(dispatch.assignment.distanceKm).toBeCloseTo(1, 0);
  });

  it('prefers a less loaded agent when distances are similar and workload weight dominates', async () => {
    const { user, token } = await createStaff();
    await setConfig({ weights: { distance: 0.1, workload: 0.9, fairness: 0 } });
    const busy = await createAgent({ location: north(0.5), maxConcurrent: 2 });
    const idle = await createAgent({ location: north(1), maxConcurrent: 2 });
    await Agent.updateOne({ _id: busy.agentId }, { $set: { activeCount: 1 } });

    const req = await createPendingRequest(user._id);
    const preview = await api().get(`/api/requests/${req.id}/candidates`).set(auth(token));

    expect(preview.status).toBe(200);
    expect(preview.body.candidates[0].agentId).toBe(idle.agentId);
    expect(preview.body.candidates[0].score.total).toBeGreaterThan(preview.body.candidates[1].score.total);
  });

  it('respects the priority-adjusted search radius', async () => {
    const { token } = await createStaff();
    await setConfig({ maxRadiusKm: 5 });
    await createAgent({ location: north(8), skills: ['repair'] });

    const normal = await createViaApi(token, { priority: 'normal' });
    const critical = await createViaApi(token, { priority: 'critical' }); // 5km x 2 = 10km radius

    expect(normal.dispatch.outcome).toBe('waiting');
    expect(critical.dispatch.outcome).toBe('offered');
  });

  it('drains the pending queue by priority when capacity frees up', async () => {
    const { user } = await createStaff();
    const low = await createPendingRequest(user._id, { priority: 'low' });
    const critical = await createPendingRequest(user._id, { priority: 'critical' });
    await createAgent();

    await runSweepOnce();

    expect((await ServiceRequest.findById(critical._id))!.status).toBe('offered');
    expect((await ServiceRequest.findById(low._id))!.status).toBe('pending');
  });

  it('keeps a request pending when nobody is available, then fails it after maxPendingSec', async () => {
    const { user, token } = await createStaff();
    const { request, dispatch } = await createViaApi(token);
    expect(dispatch.outcome).toBe('waiting');
    expect(request.status).toBe('pending');

    await setConfig({ maxPendingSec: 10 });
    // createdAt is immutable through Mongoose, so age the document via the raw driver.
    await ServiceRequest.collection.updateOne(
      { _id: new Types.ObjectId(request.id) },
      { $set: { createdAt: new Date(Date.now() - 60_000) } },
    );
    await runSweepOnce();

    const failed = await ServiceRequest.findById(request.id);
    expect(failed!.status).toBe('failed');
    expect(failed!.failureReason).toBe('NO_AGENT_AVAILABLE');
    expect(user).toBeDefined();
  });
});

describe('assignment lifecycle', () => {
  it('runs accept -> start -> complete, frees capacity and writes an audit trail', async () => {
    const { token } = await createStaff();
    const { agentId, token: agentToken } = await createAgent();
    const { request, dispatch } = await createViaApi(token);
    const id = dispatch.assignment.id;

    for (const step of ['accept', 'start', 'complete']) {
      const res = await api().post(`/api/assignments/${id}/${step}`).set(auth(agentToken));
      expect(res.status).toBe(200);
    }

    const finalRequest = await ServiceRequest.findById(request.id);
    const agent = await Agent.findById(agentId);
    expect(finalRequest!.status).toBe('completed');
    expect(agent!.activeCount).toBe(0);
    expect(agent!.stats).toMatchObject({ offered: 1, accepted: 1, completed: 1 });

    const trail = await AuditLog.find({ request: request.id }).sort({ createdAt: 1, _id: 1 });
    expect(trail.map((t) => t.action)).toEqual([
      'request.created',
      'assignment.offered',
      'assignment.accepted',
      'assignment.started',
      'assignment.completed',
    ]);

    const audit = await api().get(`/api/audit?requestId=${request.id}`).set(auth(token));
    expect(audit.body.total).toBe(5);
  });

  it('re-dispatches to the next best agent when the first one rejects', async () => {
    const { token } = await createStaff();
    const first = await createAgent({ location: north(0.5) });
    const second = await createAgent({ location: north(2) });
    const { request, dispatch } = await createViaApi(token);
    expect(request.assignedAgent).toBe(first.agentId);

    const res = await api()
      .post(`/api/assignments/${dispatch.assignment.id}/reject`)
      .set(auth(first.token))
      .send({ reason: 'Vehicle issue' });

    expect(res.status).toBe(200);
    expect(res.body.assignment.status).toBe('rejected');
    expect(res.body.redispatch.outcome).toBe('offered');
    expect(res.body.request.assignedAgent).toBe(second.agentId);

    const fresh = await ServiceRequest.findById(request.id);
    expect(fresh!.triedAgents.map(String)).toContain(first.agentId);
    expect(fresh!.attempts).toBe(2);
    expect((await Agent.findById(first.agentId))!.activeCount).toBe(0);
    expect((await Agent.findById(first.agentId))!.stats.rejected).toBe(1);
  });

  it('expires unanswered offers and moves on to another agent', async () => {
    const { token } = await createStaff();
    const first = await createAgent({ location: north(0.5) });
    const second = await createAgent({ location: north(2) });
    const { request, dispatch } = await createViaApi(token);

    await Assignment.updateOne({ _id: dispatch.assignment.id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    const sweep = await runSweepOnce();

    expect(sweep.expired).toBe(1);
    expect((await Assignment.findById(dispatch.assignment.id))!.status).toBe('expired');
    const fresh = await ServiceRequest.findById(request.id);
    expect(fresh!.status).toBe('offered');
    expect(String(fresh!.assignedAgent)).toBe(second.agentId);

    const late = await api().post(`/api/assignments/${dispatch.assignment.id}/accept`).set(auth(first.token));
    expect(late.status).toBe(409);
  });

  it('fails the request once maxAttempts offers have been declined', async () => {
    const { token } = await createStaff();
    await setConfig({ maxAttempts: 1 });
    const agent = await createAgent();
    await createAgent({ location: north(1) });
    const { request, dispatch } = await createViaApi(token);

    await api().post(`/api/assignments/${dispatch.assignment.id}/reject`).set(auth(agent.token)).send({});

    const fresh = await ServiceRequest.findById(request.id);
    expect(fresh!.status).toBe('failed');
    expect(fresh!.failureReason).toBe('MAX_ATTEMPTS_REACHED');
  });

  it('prevents agents from acting on assignments that belong to someone else', async () => {
    const { token } = await createStaff();
    await createAgent();
    const intruder = await createAgent({ location: north(9) });
    const { dispatch } = await createViaApi(token);

    const res = await api().post(`/api/assignments/${dispatch.assignment.id}/accept`).set(auth(intruder.token));
    expect(res.status).toBe(403);
  });

  it('rejects out-of-order transitions', async () => {
    const { token } = await createStaff();
    const agent = await createAgent();
    const { dispatch } = await createViaApi(token);

    const res = await api().post(`/api/assignments/${dispatch.assignment.id}/complete`).set(auth(agent.token));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });
});

describe('dispatcher operations', () => {
  it('cancels an offered request, releases the agent and treats repeats as no-ops', async () => {
    const { token } = await createStaff();
    const { agentId } = await createAgent();
    const { request, dispatch } = await createViaApi(token);

    const first = await api().post(`/api/requests/${request.id}/cancel`).set(auth(token)).send({ reason: 'Duplicate ticket' });
    const again = await api().post(`/api/requests/${request.id}/cancel`).set(auth(token)).send({ reason: 'Duplicate ticket' });

    expect(first.status).toBe(200);
    expect(first.body.request.status).toBe('cancelled');
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect((await Assignment.findById(dispatch.assignment.id))!.status).toBe('cancelled');
    expect((await Agent.findById(agentId))!.activeCount).toBe(0);
  });

  it('refuses to cancel a completed request', async () => {
    const { user, token } = await createStaff();
    const req = await createPendingRequest(user._id);
    await ServiceRequest.updateOne({ _id: req._id }, { $set: { status: 'completed' } });
    const res = await api().post(`/api/requests/${req.id}/cancel`).set(auth(token)).send({ reason: 'Too late now' });
    expect(res.status).toBe(409);
  });

  it('reassigns an accepted request to a specific agent', async () => {
    const { token } = await createStaff();
    const first = await createAgent({ location: north(0.5) });
    const second = await createAgent({ location: north(5) });
    const { request, dispatch } = await createViaApi(token);
    await api().post(`/api/assignments/${dispatch.assignment.id}/accept`).set(auth(first.token));

    const res = await api()
      .post(`/api/requests/${request.id}/reassign`)
      .set(auth(token))
      .set('Idempotency-Key', idemKey())
      .send({ agentId: second.agentId, reason: 'Customer asked for a different technician' });

    expect(res.status).toBe(200);
    expect(res.body.request.assignedAgent).toBe(second.agentId);
    expect(res.body.dispatch.assignment.mode).toBe('manual');
    expect((await Assignment.findById(dispatch.assignment.id))!.status).toBe('revoked');
    expect((await Agent.findById(first.agentId))!.activeCount).toBe(0);
    expect(await Assignment.countDocuments({ request: request.id, active: true })).toBe(1);
  });

  it('does not revoke the current agent when the reassignment target is unavailable', async () => {
    const { token } = await createStaff();
    const first = await createAgent();
    const offline = await createAgent({ online: false });
    const { request, dispatch } = await createViaApi(token);

    const res = await api()
      .post(`/api/requests/${request.id}/reassign`)
      .set(auth(token))
      .set('Idempotency-Key', idemKey())
      .send({ agentId: offline.agentId });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AGENT_UNAVAILABLE');
    expect((await Assignment.findById(dispatch.assignment.id))!.status).toBe('offered');
    expect((await Agent.findById(first.agentId))!.activeCount).toBe(1);
  });

  it('rejects manual assignment to an agent without the required skill', async () => {
    const { user, token } = await createStaff();
    const medic = await createAgent({ skills: ['medical'] });
    const req = await createPendingRequest(user._id, { category: 'repair' });

    const res = await api()
      .post(`/api/requests/${req.id}/assign`)
      .set(auth(token))
      .set('Idempotency-Key', idemKey())
      .send({ agentId: medic.agentId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AGENT_SKILL_MISMATCH');
  });

  it('only allows editing requests that are still pending', async () => {
    const { token } = await createStaff();
    const { request: pending } = await createViaApi(token);
    const edit = await api().patch(`/api/requests/${pending.id}`).set(auth(token)).send({ priority: 'critical' });
    expect(edit.status).toBe(200);
    expect(edit.body.request.priorityRank).toBe(3);

    await createAgent();
    const { request: offered } = await createViaApi(token);
    const blocked = await api().patch(`/api/requests/${offered.id}`).set(auth(token)).send({ title: 'Changed title' });
    expect(blocked.status).toBe(409);
  });

  it('returns a 400 for malformed ids and bodies', async () => {
    const { token } = await createStaff();
    const badId = await api().get('/api/requests/not-an-id').set(auth(token));
    const badBody = await api()
      .post('/api/requests')
      .set(auth(token))
      .set('Idempotency-Key', idemKey())
      .send(requestBody({ location: { lat: 200, lng: 0 } }));
    expect(badId.status).toBe(400);
    expect(badBody.status).toBe(400);
    expect(badBody.body.error.details[0].path).toBe('location.lat');
  });
});

describe('agent availability', () => {
  it('marks silent agents offline and re-queues their offers', async () => {
    const { token } = await createStaff();
    const silent = await createAgent({ location: north(0.5) });
    const backup = await createAgent({ location: north(3) });
    const { request } = await createViaApi(token);
    expect(request.assignedAgent).toBe(silent.agentId);

    // Last heartbeat one minute ago (TTL is 20s in tests).
    await redis().zadd(HEARTBEAT_KEY, Date.now() - 60_000, silent.agentId);
    const sweep = await runSweepOnce();

    expect(sweep.offline).toBe(1);
    expect((await Agent.findById(silent.agentId))!.status).toBe('offline');
    const fresh = await ServiceRequest.findById(request.id);
    expect(String(fresh!.assignedAgent)).toBe(backup.agentId);
    expect(await Assignment.countDocuments({ request: request.id, status: 'revoked' })).toBe(1);
  });

  it('brings an agent online with a heartbeat and offline on request', async () => {
    const agent = await createAgent({ online: false });

    const hb = await api()
      .post('/api/agents/me/heartbeat')
      .set(auth(agent.token))
      .send({ location: { lat: 12.95, lng: 77.6 } });
    expect(hb.status).toBe(200);
    expect(hb.body.transitioned).toBe(true);
    const online = await Agent.findById(agent.agentId);
    expect(online!.status).toBe('online');
    expect(online!.toJSON().location).toEqual({ lat: 12.95, lng: 77.6 });

    const off = await api().post('/api/agents/me/status').set(auth(agent.token)).send({ status: 'offline' });
    expect(off.status).toBe(200);
    expect(off.body.agent.status).toBe('offline');
    expect(await redis().zscore(HEARTBEAT_KEY, agent.agentId)).toBeNull();
  });

  it('lists available agents and exposes dashboard counters', async () => {
    const { token } = await createStaff();
    await createAgent();
    await createAgent({ online: false });
    const busy = await createAgent();
    await Agent.updateOne({ _id: busy.agentId }, { $set: { activeCount: 1 } });

    const available = await api().get('/api/agents?available=true').set(auth(token));
    const summary = await api().get('/api/dashboard/summary').set(auth(token));

    expect(available.body.data).toHaveLength(1);
    expect(summary.body.agents).toMatchObject({ total: 3, online: 2, available: 1, busy: 1, offline: 1 });
  });
});
