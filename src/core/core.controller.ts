import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AppRole } from '@prisma/client';
import { CurrentUser, Roles, AuthUser } from '../common/auth';
import { CoreService } from './core.service';

type BodyObject = Record<string, unknown>;

@Controller('users')
@Roles(AppRole.ADMIN, AppRole.TESTER)
export class UsersController {
  constructor(private readonly core: CoreService) {}

  @Get() list() { return this.core.listUsers(); }
  @Post() create(@CurrentUser() actor: AuthUser, @Body() body: BodyObject) { return this.core.createUser(actor, body); }
  @Put(':id') update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.core.updateUser(actor, id, body); }
}

@Controller('inventory')
export class InventoryController {
  constructor(private readonly core: CoreService) {}

  @Get()
  @Roles(AppRole.ADMIN, AppRole.TESTER, AppRole.OPERARIO)
  list(@Query('q') query = '') { return this.core.listInventory(query); }

  @Get('pieces')
  @Roles(AppRole.ADMIN, AppRole.TESTER, AppRole.OPERARIO)
  pieces(@Query('itemId') itemId?: string) { return this.core.listPieces(itemId); }

  @Get('movements')
  @Roles(AppRole.ADMIN, AppRole.TESTER, AppRole.OPERARIO)
  movements() { return this.core.listMovements(); }

  @Get('import/preview')
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  preview() { return this.core.previewImport(); }

  @Post('import')
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  import(@CurrentUser() actor: AuthUser) { return this.core.importWorkbook(actor); }

  @Post('items')
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  createItem(@CurrentUser() actor: AuthUser, @Body() body: BodyObject) { return this.core.createInventoryItem(actor, body); }

  @Put('items/:id')
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  updateItem(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.core.updateInventoryItem(actor, id, body); }

  @Post('items/:id/stock')
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  adjust(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.core.adjustStock(actor, id, body.delta, body.note); }

  @Post('pieces')
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  createPiece(@CurrentUser() actor: AuthUser, @Body() body: BodyObject) { return this.core.createPiece(actor, body); }

  @Patch('pieces/:id/state')
  @Roles(AppRole.ADMIN, AppRole.TESTER, AppRole.OPERARIO)
  setPieceState(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.core.setPieceState(actor, id, body.state, body.note); }
}

@Controller('customers')
@Roles(AppRole.ADMIN, AppRole.TESTER)
export class CustomersController {
  constructor(private readonly core: CoreService) {}

  @Get() list(@Query('q') query = '') { return this.core.listCustomers(query); }
  @Post() create(@CurrentUser() actor: AuthUser, @Body() body: BodyObject) { return this.core.createCustomer(actor, body); }
  @Put(':id') update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.core.updateCustomer(actor, id, body); }
  @Delete(':id') archive(@CurrentUser() actor: AuthUser, @Param('id') id: string) { return this.core.archiveCustomer(actor, id); }
}

@Controller('products')
@Roles(AppRole.ADMIN, AppRole.TESTER)
export class ProductsController {
  constructor(private readonly core: CoreService) {}

  @Get() list(@Query('q') query = '') { return this.core.listProducts(query); }
  @Post() create(@CurrentUser() actor: AuthUser, @Body() body: BodyObject) { return this.core.createProduct(actor, body); }
  @Put(':id') update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.core.updateProduct(actor, id, body); }
  @Delete(':id') archive(@CurrentUser() actor: AuthUser, @Param('id') id: string) { return this.core.archiveProduct(actor, id); }
}

@Controller('settings')
@Roles(AppRole.ADMIN, AppRole.TESTER)
export class SettingsController {
  constructor(private readonly core: CoreService) {}

  @Get() get() { return this.core.getSettings(); }
  @Put() update(@CurrentUser() actor: AuthUser, @Body() body: BodyObject) { return this.core.updateSettings(actor, body); }
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly core: CoreService) {}

  @Get()
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  list(@Query('q') query = '') { return this.core.listOrders(query); }

  @Get(':id')
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  get(@Param('id') id: string) { return this.core.getOrder(id); }

  @Post()
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  create(@CurrentUser() actor: AuthUser, @Body() body: BodyObject) { return this.core.createOrder(actor, body); }

  @Put(':id/status')
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  setStatus(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.core.updateOrderStatus(actor, id, body.status); }

  @Post(':id/payments')
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  payment(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.core.addPayment(actor, id, body); }
}
