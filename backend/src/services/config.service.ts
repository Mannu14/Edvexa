import { DEFAULT_DISPATCH_CONFIG, DispatchConfig, type DispatchConfigDoc } from '../models/DispatchConfig';
import type { ActorRef } from '../models/common';
import { audit } from './audit.service';

/** Returns the singleton dispatch config, creating defaults on first use. */
export async function getDispatchConfig(): Promise<DispatchConfigDoc> {
  const existing = await DispatchConfig.findOne({ key: 'default' });
  if (existing) return existing;
  try {
    return await DispatchConfig.create(DEFAULT_DISPATCH_CONFIG);
  } catch {
    // Lost a creation race with another caller; the unique key guarantees one row.
    return (await DispatchConfig.findOne({ key: 'default' }))!;
  }
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type DispatchConfigPatch = DeepPartial<
  Pick<
    DispatchConfigDoc,
    'autoDispatch' | 'maxRadiusKm' | 'candidateLimit' | 'maxAttempts' | 'maxPendingSec' | 'weights' | 'priorityRules'
  >
>;

/** Flattens a nested patch to dot-paths so partial updates do not wipe siblings. */
function toDotPaths(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  return Object.entries(obj).reduce<Record<string, unknown>>((acc, [k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(acc, toDotPaths(v as Record<string, unknown>, path));
    else if (v !== undefined) acc[path] = v;
    return acc;
  }, {});
}

export async function updateDispatchConfig(patch: DispatchConfigPatch, actor: ActorRef): Promise<DispatchConfigDoc> {
  await getDispatchConfig();
  const $set = { ...toDotPaths(patch as Record<string, unknown>), updatedBy: actor.name };
  const updated = await DispatchConfig.findOneAndUpdate({ key: 'default' }, { $set }, { new: true, runValidators: true });
  await audit({
    action: 'config.updated',
    entityType: 'config',
    entityId: updated!._id,
    actor,
    meta: { changes: patch as Record<string, unknown> },
  });
  return updated!;
}
