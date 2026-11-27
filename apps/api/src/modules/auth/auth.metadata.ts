import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../generated/prisma/client.js';

export const PUBLIC_KEY = 'solaluminios.public';
export const ROLES_KEY = 'solaluminios.roles';
export const PASSWORD_CHANGE_KEY = 'solaluminios.passwordChange';
export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
// Routes a user who must replace the initial password can still use.
export const AllowedBeforePasswordChange = () => SetMetadata(PASSWORD_CHANGE_KEY, true);
