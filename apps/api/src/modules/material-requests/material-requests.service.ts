import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MaterialRequest, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RetryableException } from '../../infrastructure/http/retryable.js';
import { audit, isLockTimeout, isUniqueViolation, nextNumber, setLockTimeout, type Tx } from '../../shared/db.js';
import type { SafeUser } from '../auth/auth.types.js';
import { matchBundle, type DispatchLineRequirement } from '../dispatch/validation.js';
import { moveBundle, requirePlace } from '../inventory/inventory.shared.js';
import { enqueue } from '../notifications/outbox.js';
import type {
  AssigneeDto,
  CancelRequestDto,
  CreateMaterialRequestDto,
  MaterialRequestQueryDto,
  PickDto,
  ReceiveDto,
  ShipDto,
} from './dto/material-request.dto.js';

// Material requests: Sales asks a warehouse (e.g. Bodega 116) for profiles
// for a retail store (e.g. Almacén 7 de agosto).
//
// - Sending it moves nothing and reserves nothing: it is a need. The
//   warehouse worker whose turn it is (round robin among the active WAREHOUSE
//   users of that warehouse, changeable by Sales) gets a task and a notice.
// - Preparing: the worker reads the chips of WHOLE bundles (loose profiles of
//   an opened bundle are taken without a chip). Each one is checked like a
//   dispatch (reference, colour, origin, supplier, location) and reserved
//   entirely, so no sale can take it meanwhile. Prepared may exceed asked
//   (whole bundles).
// - Shipping (physical exit, idempotent with its key): every prepared bundle
//   is transferred to the store and opened there (its profiles become
//   loose); its reservation is consumed. The stock is available at the store
//   from that moment. A reception task goes to the store's staff (in turn).
// - Receiving: the store marks it received (who, when and an optional note).
@Injectable()
export class MaterialRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Who prepares and who receives (in turn) ---------------------------------

  // Active WAREHOUSE users working at a location (their default location).
  private workersOf(client: Tx | PrismaService, locationId: string) {
    return client.user.findMany({
      where: { active: true, role: 'WAREHOUSE', defaultInventoryLocationId: locationId },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  // The next one after whoever got the previous request of that warehouse.
  private async nextWorker(client: Tx | PrismaService, sourceLocationId: string) {
    const workers = await this.workersOf(client, sourceLocationId);
    if (workers.length === 0) return { workers, next: null };
    const last = await client.materialRequest.findFirst({
      where: { sourceLocationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { assigneeId: true },
    });
    const index = last ? workers.findIndex((worker) => worker.id === last.assigneeId) : -1;
    return { workers, next: workers[(index + 1) % workers.length] };
  }

  async workers(sourceLocationId: string) {
    return this.nextWorker(this.prisma, sourceLocationId);
  }

  // Store staff in turn for the reception; without staff, the requester.
  private async nextReceiver(tx: Tx, request: MaterialRequest) {
    const staff = await this.workersOf(tx, request.destinationLocationId);
    if (staff.length === 0) return request.createdById;
    const last = await tx.task.findFirst({
      where: { kind: 'MATERIAL_RECEPTION', materialRequest: { destinationLocationId: request.destinationLocationId } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { assigneeId: true },
    });
    const index = last ? staff.findIndex((person) => person.id === last.assigneeId) : -1;
    return staff[(index + 1) % staff.length].id;
  }

  private async requireWorker(client: Tx | PrismaService, assigneeId: string, sourceLocationId: string) {
    const worker = await client.user.findUnique({ where: { id: assigneeId }, select: { id: true, name: true, active: true, role: true, defaultInventoryLocationId: true } });
    if (!worker?.active || worker.role !== 'WAREHOUSE' || worker.defaultInventoryLocationId !== sourceLocationId) {
      throw new BadRequestException('El responsable debe ser un bodeguero activo de la bodega que abastece');
    }
    return worker;
  }

  // --- Create and send ------------------------------------------------------------

  async create(dto: CreateMaterialRequestDto, user: SafeUser) {
    const now = Date.now();
    const dueAt = dto.dueAt ? new Date(dto.dueAt) : new Date(now + 24 * 3_600_000);
    if (dueAt.getTime() <= now + 60_000) throw new BadRequestException('La fecha límite debe ser al menos un minuto en el futuro');
    if (dueAt.getTime() > now + 366 * 86_400_000) throw new BadRequestException('La fecha límite no puede superar un año');
    try {
      const id = await this.prisma.$transaction(
        async (tx) => {
          const replay = await tx.materialRequest.findUnique({ where: { createOperationKey: dto.operationKey } });
          if (replay) {
            if (replay.createdById !== user.id) throw new ConflictException('La clave de operación ya se usó');
            return replay.id;
          }
          const source = await tx.inventoryLocation.findUnique({ where: { id: dto.sourceLocationId }, include: { branch: true } });
          if (!source?.active || !source.branch.active || source.type !== 'WAREHOUSE') {
            throw new BadRequestException('La ubicación que abastece debe ser una bodega activa');
          }
          const destination = await tx.inventoryLocation.findUnique({ where: { id: dto.destinationLocationId }, include: { branch: true } });
          if (!destination?.active || !destination.branch.active || destination.type !== 'RETAIL_STORE') {
            throw new BadRequestException('El destino debe ser un almacén activo');
          }
          // One turn at a time per warehouse: two requests sent together do
          // not both go to the same worker.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'material-request-turn:' + source.id}, 0))`;
          const assignee = dto.assigneeId
            ? await this.requireWorker(tx, dto.assigneeId, source.id)
            : (await this.nextWorker(tx, source.id)).next;
          if (!assignee) {
            throw new ConflictException(`No hay bodegueros activos en ${source.name}. Asígnales esa ubicación en Administración → Usuarios.`);
          }

          const lines: Prisma.MaterialRequestLineUncheckedCreateWithoutRequestInput[] = [];
          const seen = new Map<string, number>();
          for (const [index, line] of dto.lines.entries()) {
            const key = [line.referenceId, line.finishId, line.origin, line.supplierId ?? ''].join('|');
            if (seen.has(key)) throw new BadRequestException(`Renglón ${index + 1}: repite el material del renglón ${seen.get(key)}; suma las cantidades en uno`);
            seen.set(key, index + 1);
            const reference = await tx.reference.findUnique({ where: { id: line.referenceId } });
            if (!reference?.active) throw new BadRequestException(`Renglón ${index + 1}: la referencia no existe o está inactiva`);
            const finish = await tx.finish.findUnique({ where: { id: line.finishId } });
            if (!finish?.active) throw new BadRequestException(`Renglón ${index + 1}: el color no existe o está inactivo`);
            let supplierName: string | null = null;
            if (line.supplierId) {
              const supplier = await tx.supplier.findUnique({ where: { id: line.supplierId } });
              if (!supplier?.active || !supplier.origins.includes(line.origin)) {
                throw new BadRequestException(`Renglón ${index + 1}: el proveedor no está activo o no suministra ese origen`);
              }
              supplierName = supplier.name;
            }
            lines.push({
              lineNo: index + 1,
              referenceId: reference.id,
              finishId: finish.id,
              origin: line.origin,
              supplierId: line.supplierId ?? null,
              quantity: line.quantity,
              referenceCode: reference.code,
              referenceDescription: reference.description,
              finishCode: finish.code,
              finishDescription: finish.description,
              supplierName,
            });
          }

          const request = await tx.materialRequest.create({
            data: {
              number: await nextNumber(tx, 'material_request_number_seq', 'SM'),
              sourceLocationId: source.id,
              destinationLocationId: destination.id,
              dueAt,
              notes: dto.notes || null,
              assigneeId: assignee.id,
              createOperationKey: dto.operationKey,
              createdById: user.id,
              lines: { create: lines },
            },
          });
          const summary = lines.map((line) => `${line.quantity} perfiles ${line.referenceCode} ${line.finishCode} (${line.origin === 'CHINA' ? 'China' : 'Nacional'})`).join('; ');
          await tx.task.create({
            data: {
              title: `Solicitud ${request.number} · ${source.name} → ${destination.name}`,
              description: `Preparar y despachar: ${summary}.`,
              dueAt,
              assigneeId: assignee.id,
              createdById: user.id,
              kind: 'MATERIAL_REQUEST',
              materialRequestId: request.id,
            },
          });
          await enqueue(tx, [{ userId: assignee.id, kind: 'material-request-assigned', dedupeKey: `material-request-assigned:${request.id}:${assignee.id}` }]);
          await audit(tx, {
            entity: 'MaterialRequest',
            entityId: request.id,
            action: 'SENT',
            userId: user.id,
            data: { number: request.number, assigneeId: assignee.id, byTurn: !dto.assigneeId, lines: lines.length },
          });
          return request.id;
        },
        { maxWait: 10000, timeout: 30000 },
      );
      return this.get(id, user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replay = await this.prisma.materialRequest.findUnique({ where: { createOperationKey: dto.operationKey } });
        if (replay?.createdById === user.id) return this.get(replay.id, user);
      }
      throw error;
    }
  }

  // --- Read -------------------------------------------------------------------

  // ADMIN: every request. SALES: its own. WAREHOUSE: those it prepares or
  // receives, and those of its location (as source or destination).
  private async scope(user: SafeUser): Promise<Prisma.MaterialRequestWhereInput> {
    if (user.role === 'ADMIN') return {};
    if (user.role === 'SALES') return { createdById: user.id };
    if (user.role === 'WAREHOUSE') {
      const me = await this.prisma.user.findUnique({ where: { id: user.id }, select: { defaultInventoryLocationId: true } });
      const location = me?.defaultInventoryLocationId;
      return {
        OR: [
          { assigneeId: user.id },
          { tasks: { some: { assigneeId: user.id } } },
          ...(location ? [{ sourceLocationId: location }, { destinationLocationId: location }] : []),
        ],
      };
    }
    throw new ForbiddenException('Tu rol no tiene acceso a las solicitudes de materiales');
  }

  async list(query: MaterialRequestQueryDto, user: SafeUser) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const status: Prisma.MaterialRequestWhereInput =
      query.status === 'OPEN' ? { status: { in: ['SENT', 'PREPARING'] } } : query.status ? { status: query.status } : {};
    const where: Prisma.MaterialRequestWhereInput = { AND: [await this.scope(user), status] };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.materialRequest.count({ where }),
      this.prisma.materialRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          source: { select: { id: true, name: true } },
          destination: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          lines: { select: { quantity: true } },
          picks: { select: { quantity: true } },
        },
      }),
    ]);
    const items = rows.map(({ lines, picks, ...row }) => ({
      ...row,
      lineCount: lines.length,
      requested: lines.reduce((sum, line) => sum + line.quantity, 0),
      prepared: picks.reduce((sum, pick) => sum + pick.quantity, 0),
    }));
    return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async get(id: string, user: SafeUser) {
    const request = await this.prisma.materialRequest.findFirst({
      where: { AND: [{ id }, await this.scope(user)] },
      include: {
        source: { select: { id: true, code: true, name: true, branch: { select: { name: true } } } },
        destination: { select: { id: true, code: true, name: true, branch: { select: { name: true } } } },
        assignee: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        shippedBy: { select: { id: true, name: true } },
        receivedBy: { select: { id: true, name: true } },
        cancelledBy: { select: { id: true, name: true } },
        lines: { orderBy: { lineNo: 'asc' } },
        picks: {
          orderBy: { createdAt: 'asc' },
          include: {
            bundle: {
              select: {
                id: true,
                epc: true,
                quantity: true,
                openedAt: true,
                rack: { select: { number: true, aisle: { select: { number: true } } } },
                lot: { select: { code: true, origin: true, supplier: { select: { name: true } } } },
              },
            },
          },
        },
        tasks: { select: { id: true, kind: true, assigneeId: true, completedAt: true, cancelledAt: true, assignee: { select: { id: true, name: true } } } },
      },
    });
    if (!request) throw new NotFoundException('La solicitud no existe');
    const open = request.status === 'SENT' || request.status === 'PREPARING';
    const shipped = request.status === 'SHIPPED' || request.status === 'RECEIVED';
    const preparer = open && (user.role === 'ADMIN' || request.assigneeId === user.id);
    const reception = request.tasks.find((task) => task.kind === 'MATERIAL_RECEPTION') ?? null;
    const me = user.role === 'WAREHOUSE' ? await this.prisma.user.findUnique({ where: { id: user.id }, select: { defaultInventoryLocationId: true } }) : null;
    const receiver =
      request.status === 'SHIPPED' &&
      (user.role === 'ADMIN' || reception?.assigneeId === user.id || (user.role === 'WAREHOUSE' && me?.defaultInventoryLocationId === request.destinationLocationId));

    const lines = await Promise.all(
      request.lines.map(async (line) => {
        const picks = request.picks.filter((pick) => pick.requestLineId === line.id);
        const prepared = picks.reduce((sum, pick) => sum + pick.quantity, 0);
        return {
          ...line,
          requested: line.quantity,
          prepared,
          shipped: shipped ? prepared : 0,
          pending: Math.max(0, line.quantity - prepared),
          // Whole bundles the worker can take (not reserved), loose first.
          suggestions: preparer && prepared < line.quantity ? await this.suggestions(line, request.sourceLocationId) : [],
        };
      }),
    );
    const { tasks: _tasks, picks, ...rest } = request;
    return {
      ...rest,
      lines,
      picks: picks.map((pick) => ({
        id: pick.id,
        lineId: pick.requestLineId,
        quantity: pick.quantity,
        bundle: {
          id: pick.bundle.id,
          epc: pick.bundle.epc,
          loose: pick.bundle.openedAt !== null,
          aisle: pick.bundle.rack?.aisle.number ?? null,
          rack: pick.bundle.rack?.number ?? null,
          lot: pick.bundle.lot?.code ?? null,
          origin: pick.bundle.lot?.origin ?? null,
          supplier: pick.bundle.lot?.supplier?.name ?? null,
        },
      })),
      totals: {
        requested: lines.reduce((sum, line) => sum + line.requested, 0),
        prepared: lines.reduce((sum, line) => sum + line.prepared, 0),
        shipped: lines.reduce((sum, line) => sum + line.shipped, 0),
        bundles: picks.length,
      },
      reception: reception ? { assignee: reception.assignee, done: reception.completedAt !== null } : null,
      can: {
        prepare: preparer,
        ship: preparer && picks.length > 0,
        receive: receiver,
        reassign: open && (user.role === 'ADMIN' || request.createdById === user.id),
        cancel: open && (user.role === 'ADMIN' || request.createdById === user.id),
      },
    };
  }

  // Unreserved bundles of the source that fit the line: loose (opened)
  // first, then the oldest closed ones. At most 10.
  private async suggestions(line: { referenceId: string; finishId: string; origin: 'CHINA' | 'NATIONAL'; supplierId: string | null }, sourceLocationId: string) {
    const bundles = await this.prisma.bundle.findMany({
      where: {
        inventoryLocationId: sourceLocationId,
        referenceId: line.referenceId,
        finishId: line.finishId,
        quantity: { gt: 0 },
        lot: { origin: line.origin, ...(line.supplierId ? { supplierId: line.supplierId } : {}) },
        reservations: { none: { status: 'ACTIVE' } },
      },
      orderBy: [{ openedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 10,
      select: { id: true, epc: true, quantity: true, openedAt: true, rack: { select: { number: true, aisle: { select: { number: true } } } } },
    });
    return bundles.map((bundle) => ({
      bundleId: bundle.id,
      epc: bundle.epc,
      quantity: bundle.quantity,
      loose: bundle.openedAt !== null,
      aisle: bundle.rack?.aisle.number ?? null,
      rack: bundle.rack?.number ?? null,
    }));
  }

  // --- Preparation -------------------------------------------------------------

  private async lockRequest(tx: Tx, id: string, user: SafeUser) {
    await setLockTimeout(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "material_requests" WHERE id = ${id} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('La solicitud no existe');
    const request = await tx.materialRequest.findFirstOrThrow({ where: { id } });
    const visible = await tx.materialRequest.count({ where: { AND: [{ id }, await this.scope(user)] } });
    if (visible === 0) throw new NotFoundException('La solicitud no existe');
    return request;
  }

  private requirePreparer(request: MaterialRequest, user: SafeUser) {
    if (request.status !== 'SENT' && request.status !== 'PREPARING') {
      throw new ConflictException(request.status === 'CANCELLED' ? 'La solicitud está cancelada' : 'La solicitud ya fue despachada');
    }
    if (user.role !== 'ADMIN' && request.assigneeId !== user.id) {
      throw new ForbiddenException('Solo el bodeguero asignado (o un administrador) prepara esta solicitud');
    }
  }

  private async run<T>(work: (tx: Tx) => Promise<T>) {
    try {
      return await this.prisma.$transaction(work, { maxWait: 10000, timeout: 30000 });
    } catch (error) {
      if (isLockTimeout(error)) throw new RetryableException('La solicitud o sus paquetes están ocupados por otra operación; reintenta.');
      throw error;
    }
  }

  // Reads a chip (or takes the loose profiles of an opened bundle): checks it
  // like a dispatch and reserves the WHOLE bundle for the line it fits.
  async pick(id: string, dto: PickDto, user: SafeUser) {
    const message = await this.run(async (tx) => {
      const request = await this.lockRequest(tx, id, user);
      this.requirePreparer(request, user);
      const found = dto.bundleId
        ? await tx.bundle.findUnique({ where: { id: dto.bundleId }, select: { id: true, epc: true } })
        : await tx.bundle.findUnique({ where: { epc: dto.epc! }, select: { id: true, epc: true } });
      if (!found) throw new NotFoundException(dto.bundleId ? 'El paquete no existe' : `No hay un paquete registrado con el chip ${dto.epc}`);
      await tx.$queryRaw`SELECT id FROM "bundles" WHERE id = ${found.id} FOR UPDATE`;
      const already = await tx.materialRequestPick.findUnique({ where: { requestId_bundleId: { requestId: id, bundleId: found.id } } });
      if (already) return `El paquete ${found.epc} ya está preparado en esta solicitud; la lectura repetida no suma de nuevo.`;
      const bundle = await tx.bundle.findUniqueOrThrow({
        where: { id: found.id },
        include: { reference: true, finish: true, inventoryLocation: true, lot: { include: { supplier: true } } },
      });
      if (dto.bundleId && !bundle.openedAt) throw new BadRequestException('Un paquete cerrado se prepara leyendo su chip');
      const source = await tx.inventoryLocation.findUniqueOrThrow({ where: { id: request.sourceLocationId } });
      const lines = await tx.materialRequestLine.findMany({ where: { requestId: id }, include: { picks: { select: { quantity: true } } }, orderBy: { lineNo: 'asc' } });
      const requirements: DispatchLineRequirement[] = lines.map((line) => ({
        dispatchLineId: line.id,
        lineNo: line.lineNo,
        referenceId: line.referenceId,
        finishId: line.finishId,
        referenceCode: line.referenceCode,
        finishLabel: `${line.finishCode}${line.finishDescription ? ` — ${line.finishDescription}` : ''}`,
        origin: line.origin,
        supplierId: line.supplierId,
        supplierName: line.supplierName,
        pending: line.quantity - line.picks.reduce((sum, pick) => sum + pick.quantity, 0),
      }));
      const match = matchBundle(
        {
          id: bundle.id,
          epc: bundle.epc,
          referenceId: bundle.referenceId,
          finishId: bundle.finishId,
          referenceCode: bundle.reference.code,
          finishLabel: `${bundle.finish.code}${bundle.finish.description ? ` — ${bundle.finish.description}` : ''}`,
          quantity: bundle.quantity,
          inventoryLocationId: bundle.inventoryLocationId,
          locationLabel: bundle.inventoryLocation.name,
          origin: bundle.lot?.origin ?? null,
          supplierId: bundle.lot?.supplierId ?? null,
          supplierName: bundle.lot?.supplier?.name ?? null,
        },
        requirements,
        source.id,
        source.name,
      );
      if (!match.ok) throw new ConflictException(match.message.replace('Este despacho', 'Esta solicitud').replace('este despacho', 'esta solicitud'));
      const reserved = await tx.stockReservation.aggregate({ where: { bundleId: bundle.id, status: 'ACTIVE' }, _sum: { quantity: true } });
      if ((reserved._sum.quantity ?? 0) > 0) {
        throw new ConflictException(`El paquete ${bundle.epc} tiene perfiles reservados para otra orden o solicitud; usa otro paquete.`);
      }
      await tx.materialRequestPick.create({ data: { requestId: id, requestLineId: match.line.dispatchLineId, bundleId: bundle.id, quantity: bundle.quantity, createdById: user.id } });
      await tx.stockReservation.create({
        data: { bundleId: bundle.id, materialRequestLineId: match.line.dispatchLineId, quantity: bundle.quantity, createdById: user.id },
      });
      if (request.status === 'SENT') await tx.materialRequest.update({ where: { id }, data: { status: 'PREPARING' } });
      const over = bundle.quantity - match.line.pending;
      return `Preparado: ${bundle.openedAt ? 'sueltos del paquete' : 'paquete'} ${bundle.epc} con ${bundle.quantity} perfiles para el renglón ${match.line.lineNo}${
        over > 0 ? ` (completa lo pedido y sobran ${over}: viaja el paquete completo)` : ''
      }.`;
    });
    return { message, request: await this.get(id, user) };
  }

  // Takes a prepared bundle out of the request: its reservation is released.
  async unpick(id: string, pickId: string, user: SafeUser) {
    await this.run(async (tx) => {
      const request = await this.lockRequest(tx, id, user);
      this.requirePreparer(request, user);
      const pick = await tx.materialRequestPick.findFirst({ where: { id: pickId, requestId: id } });
      if (!pick) return;
      await tx.stockReservation.updateMany({
        where: { bundleId: pick.bundleId, materialRequestLineId: pick.requestLineId, status: 'ACTIVE' },
        data: { status: 'RELEASED', closedAt: new Date() },
      });
      await tx.materialRequestPick.delete({ where: { id: pick.id } });
      if ((await tx.materialRequestPick.count({ where: { requestId: id } })) === 0) {
        await tx.materialRequest.update({ where: { id }, data: { status: 'SENT' } });
      }
    });
    return this.get(id, user);
  }

  // --- Shipment (physical exit) ------------------------------------------------

  // Every prepared bundle is transferred, whole, to the store and opened
  // there; its reservation is consumed. Once per request: a repeated
  // confirmation with the same key changes nothing; another key is refused.
  async ship(id: string, dto: ShipDto, user: SafeUser) {
    try {
      await this.run(async (tx) => {
        const request = await this.lockRequest(tx, id, user);
        if (request.status === 'SHIPPED' || request.status === 'RECEIVED') {
          if (request.shipOperationKey === dto.operationKey) return;
          throw new ConflictException('La solicitud ya fue despachada; no se registra otra salida');
        }
        this.requirePreparer(request, user);
        const picks = await tx.materialRequestPick.findMany({ where: { requestId: id }, orderBy: { bundleId: 'asc' } });
        if (picks.length === 0) throw new BadRequestException('Prepara al menos un paquete antes de confirmar la salida');
        await tx.$queryRaw`SELECT id FROM "bundles" WHERE id = ANY(${picks.map((pick) => pick.bundleId)}::text[]) ORDER BY id FOR UPDATE`;
        const place = await requirePlace(tx, request.destinationLocationId, null);
        const now = new Date();
        const reason = `Solicitud ${request.number} → ${place.location.name}`;
        for (const pick of picks) {
          const bundle = await tx.bundle.findUniqueOrThrow({ where: { id: pick.bundleId } });
          if (bundle.inventoryLocationId !== request.sourceLocationId || bundle.quantity !== pick.quantity) {
            throw new ConflictException(`El paquete ${bundle.epc} cambió desde que se preparó (cantidad o ubicación); quítalo y vuelve a leerlo`);
          }
          const held = await tx.stockReservation.aggregate({
            where: { bundleId: bundle.id, materialRequestLineId: pick.requestLineId, status: 'ACTIVE' },
            _sum: { quantity: true },
          });
          if ((held._sum.quantity ?? 0) !== bundle.quantity) {
            throw new ConflictException(`La reserva del paquete ${bundle.epc} no coincide con lo preparado; quítalo y vuelve a leerlo`);
          }
          await tx.stockReservation.updateMany({
            where: { bundleId: bundle.id, materialRequestLineId: pick.requestLineId, status: 'ACTIVE' },
            data: { status: 'CONSUMED', closedAt: now },
          });
          const { opening, ...transfer } = await moveBundle(tx, bundle, place, reason, user.id, now);
          const key = `material-request:${dto.operationKey}:${bundle.id}`;
          await tx.inventoryMovement.create({
            data: { ...transfer, bundleId: bundle.id, occurredAt: now, performedById: user.id, operationKey: key, materialRequestId: id },
          });
          if (opening) {
            await tx.inventoryMovement.create({
              data: { ...opening, bundleId: bundle.id, occurredAt: now, performedById: user.id, operationKey: `${key}:open`, materialRequestId: id },
            });
          }
        }
        await tx.materialRequest.update({
          where: { id },
          data: { status: 'SHIPPED', shippedAt: now, shippedById: user.id, shipOperationKey: dto.operationKey },
        });
        await tx.task.updateMany({ where: { materialRequestId: id, kind: 'MATERIAL_REQUEST', completedAt: null, cancelledAt: null }, data: { completedAt: now } });
        const receiver = await this.nextReceiver(tx, request);
        const profiles = picks.reduce((sum, pick) => sum + pick.quantity, 0);
        await tx.task.create({
          data: {
            title: `Recibir ${request.number} en ${place.location.name}`,
            description: `Salió de bodega con ${picks.length} ${picks.length === 1 ? 'paquete' : 'paquetes'} (${profiles} perfiles, ya sueltos en el almacén). Márcalo como recibido al llegar.`,
            dueAt: new Date(now.getTime() + 24 * 3_600_000),
            assigneeId: receiver,
            createdById: user.id,
            kind: 'MATERIAL_RECEPTION',
            materialRequestId: id,
          },
        });
        await enqueue(tx, [
          { userId: receiver, kind: 'material-request-shipped', dedupeKey: `material-request-shipped:${id}` },
          { userId: request.createdById, kind: 'material-request-shipped', dedupeKey: `material-request-shipped:${id}` },
        ]);
        await audit(tx, { entity: 'MaterialRequest', entityId: id, action: 'SHIPPED', userId: user.id, data: { bundles: picks.length, profiles, receiverId: receiver } });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const current = await this.prisma.materialRequest.findUnique({ where: { id } });
        if (current?.shipOperationKey === dto.operationKey) return this.get(id, user);
      }
      throw error;
    }
    return this.get(id, user);
  }

  // --- Reception at the store --------------------------------------------------

  async receive(id: string, dto: ReceiveDto, user: SafeUser) {
    await this.run(async (tx) => {
      const request = await this.lockRequest(tx, id, user);
      if (request.status === 'RECEIVED') return;
      if (request.status !== 'SHIPPED') throw new ConflictException('Solo se recibe una solicitud ya despachada');
      const task = await tx.task.findFirst({ where: { materialRequestId: id, kind: 'MATERIAL_RECEPTION' } });
      const me = await tx.user.findUnique({ where: { id: user.id }, select: { defaultInventoryLocationId: true } });
      const allowed =
        user.role === 'ADMIN' || task?.assigneeId === user.id || (user.role === 'WAREHOUSE' && me?.defaultInventoryLocationId === request.destinationLocationId);
      if (!allowed) throw new ForbiddenException('Solo el personal del almacén destino (o un administrador) marca la recepción');
      const now = new Date();
      await tx.materialRequest.update({ where: { id }, data: { status: 'RECEIVED', receivedAt: now, receivedById: user.id, receptionNote: dto.note || null } });
      await tx.task.updateMany({ where: { materialRequestId: id, kind: 'MATERIAL_RECEPTION', completedAt: null, cancelledAt: null }, data: { completedAt: now } });
      await enqueue(tx, [{ userId: request.createdById, kind: 'material-request-received', dedupeKey: `material-request-received:${id}` }]);
      await audit(tx, { entity: 'MaterialRequest', entityId: id, action: 'RECEIVED', userId: user.id, reason: dto.note || null });
    });
    return this.get(id, user);
  }

  // --- Changes by the requester -----------------------------------------------

  private requireOwner(request: MaterialRequest, user: SafeUser) {
    if (request.status !== 'SENT' && request.status !== 'PREPARING') {
      throw new ConflictException(request.status === 'CANCELLED' ? 'La solicitud está cancelada' : 'La solicitud ya fue despachada');
    }
    if (user.role !== 'ADMIN' && request.createdById !== user.id) {
      throw new ForbiddenException('Solo quien creó la solicitud (o un administrador) puede cambiarla');
    }
  }

  // E.g. the worker in turn did not come today.
  async reassign(id: string, dto: AssigneeDto, user: SafeUser) {
    await this.run(async (tx) => {
      const request = await this.lockRequest(tx, id, user);
      this.requireOwner(request, user);
      if (request.assigneeId === dto.assigneeId) return;
      const worker = await this.requireWorker(tx, dto.assigneeId, request.sourceLocationId);
      await tx.materialRequest.update({ where: { id }, data: { assigneeId: worker.id } });
      await tx.task.updateMany({ where: { materialRequestId: id, kind: 'MATERIAL_REQUEST', completedAt: null }, data: { assigneeId: worker.id } });
      await enqueue(tx, [{ userId: worker.id, kind: 'material-request-assigned', dedupeKey: `material-request-assigned:${id}:${worker.id}:${Date.now()}` }]);
      await audit(tx, { entity: 'MaterialRequest', entityId: id, action: 'REASSIGNED', userId: user.id, data: { from: request.assigneeId, to: worker.id } });
    });
    return this.get(id, user);
  }

  // Before the shipment only; prepared bundles are released.
  async cancel(id: string, dto: CancelRequestDto, user: SafeUser) {
    await this.run(async (tx) => {
      const request = await this.lockRequest(tx, id, user);
      if (request.status === 'CANCELLED') return;
      this.requireOwner(request, user);
      const now = new Date();
      const released = await tx.stockReservation.updateMany({
        where: { materialRequestLine: { requestId: id }, status: 'ACTIVE' },
        data: { status: 'RELEASED', closedAt: now },
      });
      await tx.materialRequest.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: now, cancelledById: user.id, cancelReason: dto.reason } });
      await tx.task.updateMany({ where: { materialRequestId: id, completedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
      await enqueue(tx, [{ userId: request.assigneeId, kind: 'material-request-cancelled', dedupeKey: `material-request-cancelled:${id}` }]);
      await audit(tx, { entity: 'MaterialRequest', entityId: id, action: 'CANCELLED', userId: user.id, reason: dto.reason, data: { releasedReservations: released.count } });
    });
    return this.get(id, user);
  }
}
