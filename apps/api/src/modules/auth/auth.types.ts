import type { User } from '../../generated/prisma/client.js';

export type SafeUser = Pick<User,
  'id' | 'name' | 'username' | 'email' | 'role' | 'active' | 'defaultInventoryLocationId' | 'mustChangePassword'
>;

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  ip?: string;
  user?: SafeUser;
}
