import { runSweepOnce } from '../src/jobs/sweeper';
import { AppError } from '../src/lib/errors';
import { Agent } from '../src/models/Agent';
import { Assignment } from '../src/models/Assignment';
import { ServiceRequest } from '../src/models/ServiceRequest';
import { SYSTEM_ACTOR } from '../src/services/audit.service';
import { getDispatchConfig } from '../src/services/config.service';
import { offerToAgentUnlocked } from '../src/services/dispatch.service';
import {
  api,
  auth,
  createAgent,
  createPendingRequest,
  createStaff,
  idemKey,
  north,
  setConfig,
  useTestEnv,
} from './helpers';

useTestEnv();

async function totalActiveCount() {
  const agents = await Agent.find();
  return agents.reduce((n, a) => n + a.activeCount, 0);
}

describe('concurrent assignment attempts', () => {
  it('20 simultaneous manual assigns of one request to 20 agents produce exactly one assignment', async () => {
    const { user, token } = await createStaff();
    const agents = await Promise.all(Array.from({ length: 20 }, (_, i) => createAgent({ location: north(i * 0.1) })));
    const req = await createPendingRequest(user._id);

    const responses = await Promise.all(
      agents.map((a) =>
        api()
          .post(`/api/requests/${req.id}/assign`)
          .set(auth(token))
          .set('Idempotency-Key', idemKey())
          .send({ agentId: a.agentId }),
      ),
    );

    const winners = responses.filter((r) => r.status === 201);
    const losers = responses.filter((r) => r.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(19);
    losers.forEach((r) => expect(['INVALID_STATE', 'ALREADY_ASSIGNED', 'REQUEST_LOCKED']).toContain(r.body.error.code));

    expect(await Assignment.countDocuments({ request: req._id, active: true })).toBe(1);
    expect(await totalActiveCount()).toBe(1);
    const fresh = await ServiceRequest.findById(req._id);
    expect(fresh!.status).toBe('offered');
    expect(String(fresh!.assignedAgent)).toBe(winners[0].body.assignment.agent);
  });

  it('database guards alone (no Redis lock) still allow only one winner', async () => {
    // Simulates the worst case: the Redis lock expired or Redis is unavailable.
    const { user } = await createStaff();
    const agents = await Promise.all(Array.from({ length: 20 }, () => createAgent()));
    const req = await createPendingRequest(user._id);
    const cfg = await getDispatchConfig();

    const results = await Promise.allSettled(
      agents.map((a) =>
        offerToAgentUnlocked({ requestId: req._id, agentId: a.agentId, actor: SYSTEM_ACTOR, mode: 'manual', cfg }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    rejected.forEach((r) => {
      expect(r.reason).toBeInstanceOf(AppError);
      expect(['ALREADY_ASSIGNED', 'INVALID_STATE']).toContain((r.reason as AppError).code);
    });

    expect(await Assignment.countDocuments({ request: req._id, active: true })).toBe(1);
    // Every loser released the capacity it reserved.
    expect(await totalActiveCount()).toBe(1);
  });

  it('never books an agent beyond capacity when many requests target it at once', async () => {
    const { user } = await createStaff();
    const { agentId } = await createAgent({ maxConcurrent: 2 });
    const requests = await Promise.all(Array.from({ length: 10 }, () => createPendingRequest(user._id)));
    const cfg = await getDispatchConfig();

    const results = await Promise.allSettled(
      requests.map((r) => offerToAgentUnlocked({ requestId: r._id, agentId, actor: SYSTEM_ACTOR, mode: 'manual', cfg })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .forEach((r) => expect((r.reason as AppError).code).toBe('AGENT_UNAVAILABLE'));
    expect((await Agent.findById(agentId))!.activeCount).toBe(2);
    expect(await ServiceRequest.countDocuments({ status: 'offered' })).toBe(2);
  });

  it('parallel auto-dispatch of 10 requests across 3 single-capacity agents makes exactly 3 offers', async () => {
    const { user, token } = await createStaff();
    await Promise.all([0, 1, 2].map((i) => createAgent({ location: north(i) })));
    const requests = await Promise.all(Array.from({ length: 10 }, () => createPendingRequest(user._id)));

    const responses = await Promise.all(
      requests.map((r) => api().post(`/api/requests/${r.id}/dispatch`).set(auth(token))),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    const outcomes = responses.map((r) => r.body.dispatch.outcome);
    expect(outcomes.filter((o) => o === 'offered')).toHaveLength(3);
    expect(outcomes.filter((o) => o === 'waiting')).toHaveLength(7);

    const agents = await Agent.find();
    agents.forEach((a) => expect(a.activeCount).toBe(1));
    expect(await Assignment.countDocuments({ active: true })).toBe(3);
  });

  it('accept racing a cancel leaves a consistent final state', async () => {
    const { user, token: dispatcherToken } = await createStaff();
    const { agentId, token: agentToken } = await createAgent();
    const req = await createPendingRequest(user._id);
    const cfg = await getDispatchConfig();
    const { assignment } = await offerToAgentUnlocked({ requestId: req._id, agentId, actor: SYSTEM_ACTOR, mode: 'manual', cfg });

    const [accept, cancel] = await Promise.all([
      api().post(`/api/assignments/${assignment.id}/accept`).set(auth(agentToken)),
      api().post(`/api/requests/${req.id}/cancel`).set(auth(dispatcherToken)).send({ reason: 'Customer called off' }),
    ]);

    expect(cancel.status).toBe(200);
    expect([200, 409]).toContain(accept.status);

    const finalRequest = await ServiceRequest.findById(req._id);
    const finalAssignment = await Assignment.findById(assignment._id);
    expect(finalRequest!.status).toBe('cancelled');
    expect(finalAssignment!.status).toBe('cancelled');
    expect(finalAssignment!.active).toBe(false);
    expect((await Agent.findById(agentId))!.activeCount).toBe(0);
  });

  it('a late accept racing the timeout sweeper cannot resurrect an expired offer', async () => {
    const { user } = await createStaff();
    const { agentId, token } = await createAgent();
    await createAgent({ location: north(1) });
    await setConfig({ autoDispatch: false });
    const req = await createPendingRequest(user._id);
    const cfg = await getDispatchConfig();
    const { assignment } = await offerToAgentUnlocked({ requestId: req._id, agentId, actor: SYSTEM_ACTOR, mode: 'manual', cfg });
    await Assignment.updateOne({ _id: assignment._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const [accept] = await Promise.all([
      api().post(`/api/assignments/${assignment.id}/accept`).set(auth(token)),
      runSweepOnce(),
    ]);

    expect(accept.status).toBe(409);
    expect(['OFFER_EXPIRED', 'INVALID_STATE']).toContain(accept.body.error.code);

    // The sweeper never waits on a busy request lock; if the accept held it,
    // the expiry is simply picked up on the next tick.
    await runSweepOnce();
    expect((await Assignment.findById(assignment._id))!.status).toBe('expired');
    expect((await Agent.findById(agentId))!.activeCount).toBe(0);
  });

  it('duplicate accepts from a flaky client are harmless', async () => {
    const { user } = await createStaff();
    const { agentId, token } = await createAgent();
    const req = await createPendingRequest(user._id);
    const cfg = await getDispatchConfig();
    const { assignment } = await offerToAgentUnlocked({ requestId: req._id, agentId, actor: SYSTEM_ACTOR, mode: 'manual', cfg });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => api().post(`/api/assignments/${assignment.id}/accept`).set(auth(token))),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.body.replayed === false)).toHaveLength(1);
    expect((await Agent.findById(agentId))!.stats.accepted).toBe(1);
  });

  it('an accept whose request update fails does not count towards stats.accepted', async () => {
    const { user } = await createStaff();
    const { agentId, token } = await createAgent();
    const req = await createPendingRequest(user._id);
    const cfg = await getDispatchConfig();
    const { assignment } = await offerToAgentUnlocked({ requestId: req._id, agentId, actor: SYSTEM_ACTOR, mode: 'manual', cfg });
    const before = (await Agent.findById(agentId))!.stats.accepted;

    // Bypass the service so the assignment stays 'offered' but the request's conditional update cannot match.
    await ServiceRequest.updateOne({ _id: req._id }, { $set: { status: 'cancelled' } });

    const accept = await api().post(`/api/assignments/${assignment.id}/accept`).set(auth(token));

    expect(accept.status).toBe(409);
    expect(accept.body.error.code).toBe('INVALID_STATE');
    expect((await Agent.findById(agentId))!.stats.accepted).toBe(before);
    // The defensive branch must also leave no orphaned assignment or leaked capacity.
    expect((await Assignment.findById(assignment._id))!.status).toBe('cancelled');
    expect((await Agent.findById(agentId))!.activeCount).toBe(0);
  });
});
