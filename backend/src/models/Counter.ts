import { Schema, model } from 'mongoose';

interface ICounter {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<ICounter>({ _id: { type: String }, seq: { type: Number, default: 0 } });

export const Counter = model<ICounter>('Counter', counterSchema);

/** Atomic sequence used for human-readable codes (REQ-1001, REQ-1002, ...). */
export async function nextSequence(name: string, offset = 1000): Promise<number> {
  const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return offset + doc!.seq;
}
