import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { ACCENT_FOLD_FROM, ACCENT_FOLD_TO, escapeLike, foldAccents } from '../../shared/search.js';
import { normalizeReferenceCode } from './catalog-codes.js';
import { CreateReferenceDto } from './dto/create-reference.dto.js';
import { UpdateReferenceDto } from './dto/update-reference.dto.js';
import { CreateFinishDto } from './dto/create-finish.dto.js';
import { UpdateFinishDto } from './dto/update-finish.dto.js';
import type {
  CreateFamilyDto,
  ListFamiliesQueryDto,
  ListReferencesQueryDto,
  UpdateFamilyDto,
} from './dto/family.dto.js';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async createReference(dto: CreateReferenceDto) {
    if (dto.familyId) {
      await this.requireAssignableFamily(dto.familyId);
    }

    try {
      return await this.prisma.reference.create({
        data: {
          code: dto.code,
          description: dto.description || null,
          familyId: dto.familyId || null,
          familyHint: dto.familyHint || null,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ya existe una referencia con ese código',
        );
      }

      throw error;
    }
  }

  async listReferences(query: ListReferencesQueryDto = {}) {
    if (query.familyId !== undefined) {
      await this.requireFamily(query.familyId);
    }

    const search = query.search ?? '';
    if (!search) {
      return this.prisma.reference.findMany({
        where:
          query.familyId !== undefined ? { familyId: query.familyId } : undefined,
        orderBy: {
          code: 'asc',
        },
      });
    }

    // By code or description, ignoring case and accents. The exact code
    // first, then codes that start with the text (shorter first: «38» → 386
    // before 3809), then the rest.
    const code = normalizeReferenceCode(search);
    const text = foldAccents(search);
    const matches = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "references"
      WHERE (${query.familyId ?? null}::text IS NULL OR "familyId" = ${query.familyId ?? null})
        AND (
          upper(code) LIKE ${`%${escapeLike(code)}%`}
          OR translate(lower(coalesce(description, '')), ${ACCENT_FOLD_FROM}, ${ACCENT_FOLD_TO}) LIKE ${`%${escapeLike(text)}%`}
        )
      ORDER BY (upper(code) = ${code}) DESC, (upper(code) LIKE ${`${escapeLike(code)}%`}) DESC, length(code), code, id
      LIMIT 50`;
    const found = await this.prisma.reference.findMany({ where: { id: { in: matches.map((m) => m.id) } } });
    const order = new Map(matches.map((m, index) => [m.id, index]));
    return found.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  async getReference(id: string) {
    const reference = await this.prisma.reference.findUnique({
      where: { id },
    });

    if (!reference) {
      throw new NotFoundException('La referencia no existe');
    }

    return reference;
  }

  // expectedUpdatedAt (optional): the version the client saw. The update is a
  // single conditional statement, so an edit based on an old version is
  // refused (409) instead of silently overwriting someone else's change.
  async updateReference(id: string, dto: UpdateReferenceDto) {
    if (
      dto.description === undefined &&
      dto.active === undefined &&
      dto.familyId === undefined &&
      dto.familyHint === undefined
    ) {
      throw new BadRequestException(
        'Debes enviar una descripción, un estado, una familia o una pista de familia',
      );
    }

    const data: Prisma.ReferenceUncheckedUpdateManyInput = {};

    if (dto.familyId !== undefined) {
      const current = await this.getReference(id);
      // Keeping the current family is allowed even if it was deactivated.
      if (dto.familyId !== null && dto.familyId !== current.familyId) {
        await this.requireAssignableFamily(dto.familyId);
      }
      data.familyId = dto.familyId;
    }

    if (dto.description !== undefined) {
      data.description = dto.description || null;
    }

    if (dto.active !== undefined) {
      data.active = dto.active;
    }

    if (dto.familyHint !== undefined) {
      data.familyHint = dto.familyHint || null;
    }

    const { count } = await this.prisma.reference.updateMany({
      where: { id, ...versionWhere(dto.expectedUpdatedAt) },
      data,
    });
    const reference = await this.prisma.reference.findUnique({ where: { id } });
    if (!reference) throw new NotFoundException('La referencia no existe');
    if (count === 0) {
      throw new ConflictException(
        'La referencia fue modificada por otra persona. Recarga y vuelve a intentarlo.',
      );
    }
    return reference;
  }

  // With the number of active references of each family (shown by the
  // phone picker on every family).
  async listFamilies(query: ListFamiliesQueryDto = {}) {
    const families = await this.prisma.productFamily.findMany({
      where: query.active !== undefined ? { active: query.active } : undefined,
      orderBy: {
        code: 'asc',
      },
      include: { _count: { select: { references: { where: { active: true } } } } },
    });
    return families.map(({ _count, ...family }) => ({ ...family, activeReferences: _count.references }));
  }

  async createFamily(dto: CreateFamilyDto) {
    try {
      return await this.prisma.productFamily.create({
        data: {
          code: dto.code,
          name: dto.name,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe una familia con ese código');
      }

      throw error;
    }
  }

  // Deactivating a family keeps its references associated; it only blocks
  // new associations.
  async updateFamily(id: string, dto: UpdateFamilyDto) {
    if (dto.name === undefined && dto.active === undefined) {
      throw new BadRequestException('Debes enviar un nombre o un estado');
    }

    const data: Prisma.ProductFamilyUpdateManyMutationInput = {};

    if (dto.name !== undefined) {
      data.name = dto.name;
    }

    if (dto.active !== undefined) {
      data.active = dto.active;
    }

    const { count } = await this.prisma.productFamily.updateMany({
      where: { id, ...versionWhere(dto.expectedUpdatedAt) },
      data,
    });
    const family = await this.prisma.productFamily.findUnique({ where: { id } });
    if (!family) throw new NotFoundException('La familia no existe');
    if (count === 0) {
      throw new ConflictException(
        'La familia fue modificada por otra persona. Recarga y vuelve a intentarlo.',
      );
    }
    return family;
  }

  private async requireFamily(id: string) {
    const family = await this.prisma.productFamily.findUnique({
      where: { id },
    });

    if (!family) {
      throw new NotFoundException('La familia no existe');
    }

    return family;
  }

  private async requireAssignableFamily(id: string) {
    const family = await this.requireFamily(id);

    if (!family.active) {
      throw new BadRequestException(
        'La familia está inactiva y no admite nuevas referencias',
      );
    }

    return family;
  }

  listFinishes() {
    return this.prisma.finish.findMany({
      orderBy: {
        description: 'asc',
      },
    });
  }

  async createFinish(dto: CreateFinishDto) {
    try {
      return await this.prisma.finish.create({
        data: {
          code: dto.code,
          description: dto.description,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ya existe un color con ese código',
        );
      }

      throw error;
    }
  }

  async updateFinish(id: string, dto: UpdateFinishDto) {
    if (dto.description === undefined && dto.active === undefined) {
      throw new BadRequestException(
        'Debes enviar un nombre o un estado',
      );
    }

    const data: Prisma.FinishUpdateInput = {};

    if (dto.description !== undefined) {
      data.description = dto.description;
    }

    if (dto.active !== undefined) {
      data.active = dto.active;
    }

    try {
      return await this.prisma.finish.update({
        where: { id },
        data,
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('El color no existe');
      }

      throw error;
    }
  }
}

// Optimistic concurrency condition: only update the version the client saw.
function versionWhere(expectedUpdatedAt: string | undefined) {
  return expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {};
}
