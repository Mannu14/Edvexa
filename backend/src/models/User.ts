import { Schema, Types, model, type HydratedDocument } from 'mongoose';
import { ROLES, applyJsonTransform, type Role } from './common';

export interface IUser {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  agent: Types.ObjectId | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    agent: { type: Schema.Types.ObjectId, ref: 'Agent', default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

applyJsonTransform(userSchema, ['passwordHash']);

export type UserDoc = HydratedDocument<IUser>;
export const User = model<IUser>('User', userSchema);
