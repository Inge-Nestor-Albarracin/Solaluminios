import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { UsersService } from './users.service.js';

// Unit test: the real database always has the local administrator, so the
// "last active admin" rule is checked with a fake transaction client.
describe('UsersService.setActive', () => {
  const build = (activeAdminIds: string[]) => {
    const update = vi.fn(async ({ where, data }: { where: { id: string }; data: { active: boolean } }) => ({
      id: where.id,
      active: data.active,
    }));
    const tx = {
      $queryRaw: vi.fn(async () => activeAdminIds.map((id) => ({ id }))),
      user: { update },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    return { service: new UsersService(prisma), tx, update };
  };

  it('refuses to deactivate the last active administrator', async () => {
    const { service, update } = build(['admin-1']);
    await expect(service.setActive('admin-1', false, 'admin-2')).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('allows deactivating an admin when another active admin remains', async () => {
    const { service, update } = build(['admin-1', 'admin-2']);
    await expect(service.setActive('admin-1', false, 'admin-2')).resolves.toMatchObject({ active: false });
    expect(update).toHaveBeenCalledOnce();
  });

  it('allows deactivating non-admin users and reactivating anyone', async () => {
    const { service, tx } = build(['admin-1']);
    await expect(service.setActive('warehouse-1', false, 'admin-1')).resolves.toMatchObject({ active: false });
    await expect(service.setActive('admin-9', true, 'admin-1')).resolves.toMatchObject({ active: true });
    // Reactivation does not need to lock the admins.
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
  });

  it('still refuses self-deactivation', async () => {
    const { service } = build(['admin-1', 'admin-2']);
    await expect(service.setActive('admin-1', false, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
