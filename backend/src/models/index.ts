import { Agent } from './Agent';
import { Assignment } from './Assignment';
import { AuditLog } from './AuditLog';
import { Counter } from './Counter';
import { DispatchConfig } from './DispatchConfig';
import { ServiceRequest } from './ServiceRequest';
import { User } from './User';

export { Agent, Assignment, AuditLog, Counter, DispatchConfig, ServiceRequest, User };

export function registerModels() {
  return [User, Agent, ServiceRequest, Assignment, AuditLog, DispatchConfig, Counter];
}
