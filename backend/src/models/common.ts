import { Schema } from 'mongoose';

export const ROLES = ['admin', 'dispatcher', 'agent'] as const;
export type Role = (typeof ROLES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, critical: 3 };

export const CATEGORIES = ['delivery', 'repair', 'medical', 'installation'] as const;
export type Category = (typeof CATEGORIES)[number];

export const REQUEST_STATUSES = [
  'pending',
  'offered',
  'accepted',
  'in_progress',
  'completed',
  'cancelled',
  'failed',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const OPEN_REQUEST_STATUSES: RequestStatus[] = ['pending', 'offered', 'accepted', 'in_progress'];

export const ASSIGNMENT_STATUSES = [
  'offered',
  'accepted',
  'in_progress',
  'completed',
  'rejected',
  'expired',
  'cancelled',
  'revoked',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export interface GeoPoint {
  type: 'Point';
  coordinates: number[];
}

export const pointSchema = new Schema<GeoPoint>(
  {
    type: { type: String, enum: ['Point'], default: 'Point', required: true },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (v: number[]) => v.length === 2 && Math.abs(v[0]) <= 180 && Math.abs(v[1]) <= 90,
        message: 'coordinates must be [lng, lat]',
      },
    },
  },
  { _id: false },
);

export interface ActorRef {
  id?: string | null;
  role: Role | 'system';
  name: string;
}

export const actorSchema = new Schema<ActorRef>(
  {
    id: { type: String, default: null },
    role: { type: String, required: true },
    name: { type: String, required: true },
  },
  { _id: false },
);

/** Consistent JSON shape: `id` instead of `_id`, GeoJSON points as {lat, lng}. */
export function applyJsonTransform(schema: Schema, hidden: string[] = []): void {
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: (_doc: unknown, ret: Record<string, any>) => {
      ret.id = String(ret._id);
      delete ret._id;
      for (const field of hidden) delete ret[field];
      if (ret.location?.coordinates) {
        ret.location = { lng: ret.location.coordinates[0], lat: ret.location.coordinates[1] };
      }
      return ret;
    },
  });
}
