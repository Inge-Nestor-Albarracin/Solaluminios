import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Customer search of the quote: by name ignoring case and accents, and by
// NIT ignoring dots, dashes and spaces. Only active customers; the user's
// % and _ are taken literally.
describe('Customer search (e2e)', () => {
  const S = uniqueSuffix();
  // Unique digits for this run's NITs.
  const N = String(Date.now()).slice(-6);
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let headers: Record<string, string>;
  let userId = '';
  const ids: Record<string, string> = {};
  let ip = 0;
  const search = async (term: string) => {
    ip += 1;
    const res = await request(app.getHttpServer())
      .get(`/customers?search=${encodeURIComponent(term)}`)
      .set({ ...headers, 'X-Forwarded-For': `10.67.0.${(ip % 250) + 1}` })
      .expect(200);
    return (res.body as { id: string }[]).map((c) => c.id);
  };

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    const user = await createTestUser(app, 'SALES', `CS${S}`);
    headers = user.headers;
    userId = user.id;
    const create = (name: string, taxId: string | null, active = true) => prisma.customer.create({ data: { name, taxId, active, createdById: userId } });
    ids.pena = (await create(`Peña Ventanería ${S}`, `900.${N}.456-7`)).id;
    ids.plain = (await create(`Vidrios del Norte ${S}`, `80 ${N} 12`)).id;
    ids.inactive = (await create(`Peña Antigua ${S}`, `901.${N}.000-1`, false)).id;
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    if (prisma) {
      await prisma.customer.deleteMany({ where: { id: { in: Object.values(ids) } } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await app?.close();
  });

  it('finds by name ignoring case and accents', async () => {
    expect(await search(`pena ventaneria ${S.toLowerCase()}`)).toEqual([ids.pena]);
    expect(await search(`PEÑA VENTANERÍA ${S}`)).toEqual([ids.pena]);
    expect(await search(`vidrios del norte ${S}`)).toEqual([ids.plain]);
  });

  it('finds by NIT with or without dots, dashes and spaces', async () => {
    expect(await search(`900${N}4567`)).toEqual([ids.pena]);
    expect(await search(`900.${N}.456-7`)).toEqual([ids.pena]);
    expect(await search(`${N}456`)).toEqual([ids.pena]);
    expect(await search(`80${N}12`)).toEqual([ids.plain]);
  });

  it('leaves inactive customers out and takes % and _ literally', async () => {
    expect(await search(`Peña Antigua ${S}`)).toEqual([]);
    expect(await search(`901${N}0001`)).toEqual([]);
    expect(await search(`%${S}`)).toEqual([]);
    expect(await search(`Pe_a Ventaner_a ${S}`)).toEqual([]);
  });
});
