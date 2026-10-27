import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  CreateAisleDto,
  CreateBranchDto,
  CreateInventoryLocationDto,
  CreateRackDto,
} from './dto/create-location.dto.js';
import { LocationsService } from './locations.service.js';

@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get('branches')
  listBranches() {
    return this.locationsService.listBranches();
  }

  @Post('branches')
  createBranch(@Body() dto: CreateBranchDto) {
    return this.locationsService.createBranch(dto);
  }

  @Get('branches/:branchId/inventory-locations')
  listInventoryLocations(@Param('branchId') branchId: string) {
    return this.locationsService.listInventoryLocations(branchId);
  }

  // Every active location with its branch (selectors that span branches).
  @Get('inventory-locations')
  listAllInventoryLocations() {
    return this.locationsService.listAllInventoryLocations();
  }

  @Post('inventory-locations')
  createInventoryLocation(@Body() dto: CreateInventoryLocationDto) {
    return this.locationsService.createInventoryLocation(dto);
  }

  @Get('inventory-locations/:inventoryLocationId/aisles')
  listAisles(@Param('inventoryLocationId') inventoryLocationId: string) {
    return this.locationsService.listAisles(inventoryLocationId);
  }

  @Post('aisles')
  createAisle(@Body() dto: CreateAisleDto) {
    return this.locationsService.createAisle(dto);
  }

  @Get('aisles/:aisleId/racks')
  listRacks(@Param('aisleId') aisleId: string) {
    return this.locationsService.listRacks(aisleId);
  }

  @Post('racks')
  createRack(@Body() dto: CreateRackDto) {
    return this.locationsService.createRack(dto);
  }
}
