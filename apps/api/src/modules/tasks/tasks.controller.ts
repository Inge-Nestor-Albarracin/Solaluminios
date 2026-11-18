import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Roles } from '../auth/auth.metadata.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import {
  CreateTaskDto,
  ListTasksQueryDto,
  TaskSummaryQueryDto,
} from './dto/task.dto.js';
import { TasksService } from './tasks.service.js';

// Every role manages its own tasks; the service decides who may assign to
// others (ADMIN) and who may complete (the assignee).
const ALL_ROLES = ['ADMIN', 'WAREHOUSE', 'SALES', 'READ_ONLY', 'BILLING'] as const;

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Roles(...ALL_ROLES)
  @Post()
  create(@Body() dto: CreateTaskDto, @Req() request: AuthenticatedRequest) {
    return this.tasks.create(dto, sessionUser(request));
  }

  @Roles(...ALL_ROLES)
  @Get()
  list(@Query() query: ListTasksQueryDto, @Req() request: AuthenticatedRequest) {
    return this.tasks.list(query, sessionUser(request));
  }

  @Roles(...ALL_ROLES)
  @Get('summary')
  summary(@Query() query: TaskSummaryQueryDto, @Req() request: AuthenticatedRequest) {
    return this.tasks.summary(query, sessionUser(request));
  }

  @Roles(...ALL_ROLES)
  @Get(':id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.tasks.get(id, sessionUser(request));
  }

  @Roles(...ALL_ROLES)
  @Patch(':id/complete')
  @HttpCode(HttpStatus.OK)
  complete(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.tasks.complete(id, sessionUser(request));
  }
}

function sessionUser(request: AuthenticatedRequest) {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}
