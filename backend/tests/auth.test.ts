import { SYSTEM_ACTOR } from '../src/services/audit.service';
import { createUser } from '../src/services/auth.service';
import { api, auth, createAgent, createPendingRequest, createStaff, idemKey, requestBody, useTestEnv } from './helpers';

useTestEnv();

describe('authentication', () => {
  it('issues a JWT for valid credentials', async () => {
    await createUser({ name: 'Dee', email: 'dee@test.local', password: 'Passw0rd!', role: 'dispatcher' }, SYSTEM_ACTOR);
    const res = await api().post('/api/auth/login').send({ email: 'DEE@test.local', password: 'Passw0rd!' });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ email: 'dee@test.local', role: 'dispatcher' });
    expect(res.body.user.passwordHash).toBeUndefined();

    const me = await api().get('/api/auth/me').set(auth(res.body.token));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('dee@test.local');
  });

  it('rejects a wrong password with a generic error', async () => {
    await createUser({ name: 'Dee', email: 'dee@test.local', password: 'Passw0rd!', role: 'dispatcher' }, SYSTEM_ACTOR);
    const wrong = await api().post('/api/auth/login').send({ email: 'dee@test.local', password: 'nope' });
    const unknown = await api().post('/api/auth/login').send({ email: 'ghost@test.local', password: 'nope' });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('validates the login payload', async () => {
    const res = await api().post('/api/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.requestId).toEqual(expect.any(String));
  });

  it('rejects missing and tampered tokens', async () => {
    const missing = await api().get('/api/requests');
    const tampered = await api().get('/api/requests').set(auth('abc.def.ghi'));
    expect(missing.status).toBe(401);
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('role-based access control', () => {
  it('blocks agents from creating requests or listing agents', async () => {
    const { token } = await createAgent();
    const create = await api()
      .post('/api/requests')
      .set(auth(token))
      .set('Idempotency-Key', idemKey())
      .send(requestBody());
    const list = await api().get('/api/agents').set(auth(token));

    expect(create.status).toBe(403);
    expect(list.status).toBe(403);
  });

  it('blocks dispatchers from changing dispatch config and managing users', async () => {
    const { token } = await createStaff('dispatcher');
    const config = await api().put('/api/config/dispatch').set(auth(token)).send({ maxRadiusKm: 50 });
    const users = await api().get('/api/users').set(auth(token));
    const read = await api().get('/api/config/dispatch').set(auth(token));

    expect(config.status).toBe(403);
    expect(users.status).toBe(403);
    expect(read.status).toBe(200);
  });

  it('allows admins to update config with validation', async () => {
    const { token } = await createStaff('admin');
    const bad = await api().put('/api/config/dispatch').set(auth(token)).send({ maxRadiusKm: -1 });
    const good = await api()
      .put('/api/config/dispatch')
      .set(auth(token))
      .send({ weights: { distance: 0.9 }, priorityRules: { critical: { offerTimeoutSec: 15 } } });

    expect(bad.status).toBe(400);
    expect(good.status).toBe(200);
    expect(good.body.config.weights).toMatchObject({ distance: 0.9, workload: 0.25, fairness: 0.15 });
    expect(good.body.config.priorityRules.critical).toEqual({ radiusMultiplier: 2, offerTimeoutSec: 15 });
  });

  it('blocks dispatchers from responding to assignments on behalf of agents', async () => {
    const { token } = await createStaff('dispatcher');
    const res = await api().post('/api/assignments/64b000000000000000000000/accept').set(auth(token));
    expect(res.status).toBe(403);
  });

  it('hides requests that were never offered to the agent', async () => {
    const { user } = await createStaff('dispatcher');
    const { token } = await createAgent();
    const req = await createPendingRequest(user._id);
    const res = await api().get(`/api/requests/${req.id}`).set(auth(token));
    expect(res.status).toBe(404);
  });

  it('lets admins create agent users with a linked profile', async () => {
    const { token } = await createStaff('admin');
    const res = await api()
      .post('/api/users')
      .set(auth(token))
      .send({
        name: 'New Agent',
        email: 'new.agent@test.local',
        password: 'Secret123!',
        role: 'agent',
        agent: { skills: ['repair'], location: { lat: 12.9, lng: 77.6 } },
      });
    expect(res.status).toBe(201);
    expect(res.body.user.agent).toEqual(expect.any(String));

    const dup = await api()
      .post('/api/users')
      .set(auth(token))
      .send({ name: 'Again', email: 'new.agent@test.local', password: 'Secret123!', role: 'dispatcher' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
  });
});
