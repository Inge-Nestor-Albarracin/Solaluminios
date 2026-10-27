import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type {
  CreateAisleDto,
  CreateBranchDto,
  CreateInventoryLocationDto,
  CreateRackDto,
} from './dto/create-location.dto.js';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  listBranches() {
    return this.prisma.branch.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
  }

  createBranch(dto: CreateBranchDto) {
    return this.createUnique(
      () => this.prisma.branch.create({
        data: { code: dto.code, name: dto.name, address: dto.address || null },
      }),
      'Ya existe una sucursal con ese código',
    );
  }

  async listInventoryLocations(branchId: string) {
    await this.requireBranch(branchId);
    return this.prisma.inventoryLocation.findMany({
      where: { branchId, active: true },
      orderBy: { name: 'asc' },
    });
  }

  listAllInventoryLocations() {
    return this.prisma.inventoryLocation.findMany({
      where: { active: true, branch: { active: true } },
      select: { id: true, code: true, name: true, type: true, branch: { select: { id: true, code: true, name: true } } },
      orderBy: [{ branch: { name: 'asc' } }, { name: 'asc' }],
    });
  }

  async createInventoryLocation(dto: CreateInventoryLocationDto) {
    await this.requireBranch(dto.branchId);
    return this.createUnique(
      () => this.prisma.inventoryLocation.create({
        data: {
          branchId: dto.branchId,
          code: dto.code,
          name: dto.name,
          type: dto.type ?? 'WAREHOUSE',
        },
      }),
      'Ya existe una ubicación con ese código en la sucursal',
    );
  }

  async listAisles(inventoryLocationId: string) {
    await this.requireInventoryLocation(inventoryLocationId);
    return this.prisma.aisle.findMany({
      where: { inventoryLocationId, active: true },
      orderBy: { number: 'asc' },
    });
  }

  async createAisle(dto: CreateAisleDto) {
    await this.requireInventoryLocation(dto.inventoryLocationId);
    return this.createUnique(
      () => this.prisma.aisle.create({
        data: {
          inventoryLocationId: dto.inventoryLocationId,
          number: dto.number,
          floorNumber: dto.floorNumber ?? null,
        },
      }),
      'Ya existe ese pasillo en la ubicación seleccionada',
    );
  }

  async listRacks(aisleId: string) {
    await this.requireAisle(aisleId);
    return this.prisma.rack.findMany({
      where: { aisleId, active: true },
      orderBy: { number: 'asc' },
    });
  }

  async createRack(dto: CreateRackDto) {
    await this.requireAisle(dto.aisleId);
    return this.createUnique(
      () => this.prisma.rack.create({
        data: { aisleId: dto.aisleId, number: dto.number },
      }),
      'Ya existe ese burro en el pasillo seleccionado',
    );
  }

  private async requireBranch(id: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('La sucursal no existe');
    if (!branch.active) throw new BadRequestException('La sucursal está inactiva');
    return branch;
  }

  private async requireInventoryLocation(id: string) {
    const location = await this.prisma.inventoryLocation.findUnique({
      where: { id },
      include: { branch: { select: { active: true } } },
    });
    if (!location) throw new NotFoundException('La ubicación no existe');
    if (!location.active || !location.branch.active) {
      throw new BadRequestException('La ubicación o su sucursal está inactiva');
    }
    return location;
  }

  private async requireAisle(id: string) {
    const aisle = await this.prisma.aisle.findUnique({
      where: { id },
      include: {
        inventoryLocation: {
          include: { branch: { select: { active: true } } },
        },
      },
    });
    if (!aisle) throw new NotFoundException('El pasillo no existe');
    if (
      !aisle.active ||
      !aisle.inventoryLocation.active ||
      !aisle.inventoryLocation.branch.active
    ) {
      throw new BadRequestException('El pasillo o su ubicación está inactivo');
    }
    return aisle;
  }

  private async createUnique<T>(operation: () => Promise<T>, message: string): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(message);
      }
      throw error;
    }
  }
}
