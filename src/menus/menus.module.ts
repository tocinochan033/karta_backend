import { Module } from '@nestjs/common';
import { MenusController } from './menus.controller';
import { MenusService } from './menus.service';
import { DishImageStorageService } from './dish-image-storage.service';

@Module({
  controllers: [MenusController],
  providers: [MenusService, DishImageStorageService],
})
export class MenusModule {}
