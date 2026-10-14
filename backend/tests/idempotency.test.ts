import { ServiceRequest } from '../src/models/ServiceRequest';
import { api, auth, createAgent, createPendingRequest, createStaff, idemKey, requestBody, useTestEnv } from './helpers';
import { Assignment } from '../src/models/Assignment';

useTestEnv();

describe('idempotency keys', () => {
  it('requires a key on request creation', async () => {
    const { token } = await createStaff();
    const res = await api().post('/api/requests').set(auth(token)).send(requestBody());
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Idempotency-Key/);
  });

  it('replays the original response for a retried create and stores one document', async () => {
    const { token } = await createStaff();
    const key = idemKey();

    const first = await api().post('/api/requests').set(auth(token)).set('Idempotency-Key', key).send(requestBody());
    const retry = await api().post('/api/requests').set(auth(token)).set('Idempotency-Key', key).send(requestBody());

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.request.id).toBe(first.body.request.id);
    expect(await ServiceRequest.countDocuments()).toBe(1);
  });

  it('rejects the same key with a different payload', async () => {
    const { token } = await createStaff();
    const key = idemKey();
    await api().post('/api/requests').set(auth(token)).set('Idempotency-Key', key).send(requestBody());
    const res = await api()
      .post('/api/requests')
      .set(auth(token))
      .set('Idempotency-Key', key)
      .send(requestBody({ title: 'Something else' }));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('creates exactly one request when 10 identical calls race with the same key', async () => {
    const { token } = await createStaff();
    const key = idemKey();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        api().post('/api/requests').set(auth(token)).set('Idempotency-Key', key).send(requestBody()),
      ),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    const ids = new Set(responses.filter((r) => r.status === 201).map((r) => r.body.request.id));
    expect(ids.size).toBe(1);
    expect(await ServiceRequest.countDocuments()).toBe(1);
    responses
      .filter((r) => r.status === 409)
      .forEach((r) => expect(r.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS'));
  });

  it('releases the key when the request fails so the client can retry', async () => {
    const { token } = await createStaff();
    const key = idemKey();

    const invalid = await api()
      .post('/api/requests')
      .set(auth(token))
      .set('Idempotency-Key', key)
      .send(requestBody({ category: 'unknown' }));
    const valid = await api().post('/api/requests').set(auth(token)).set('Idempotency-Key', key).send(requestBody());

    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(201);
  });

  it('scopes keys per user', async () => {
    const a = await createStaff();
    const b = await createStaff();
    const key = idemKey();

    const ra = await api().post('/api/requests').set(auth(a.token)).set('Idempotency-Key', key).send(requestBody());
    const rb = await api().post('/api/requests').set(auth(b.token)).set('Idempotency-Key', key).send(requestBody());

    expect(ra.body.request.id).not.toBe(rb.body.request.id);
    expect(await ServiceRequest.countDocuments()).toBe(2);
  });

  it('does not create a second assignment when a manual assign is retried', async () => {
    const { user, token } = await createStaff();
    const { agentId } = await createAgent();
    const req = await createPendingRequest(user._id);
    const key = idemKey();

    const first = await api()
      .post(`/api/requests/${req.id}/assign`)
      .set(auth(token))
      .set('Idempotency-Key', key)
      .send({ agentId });
    const retry = await api()
      .post(`/api/requests/${req.id}/assign`)
      .set(auth(token))
      .set('Idempotency-Key', key)
      .send({ agentId });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.assignment.id).toBe(first.body.assignment.id);
    expect(await Assignment.countDocuments()).toBe(1);
  });
});
