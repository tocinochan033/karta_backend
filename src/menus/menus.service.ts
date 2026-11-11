import { ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreateDishDto } from './dto/create-dish.dto';
import { toNumber } from '../common/utils';
import { DishImageStorageService, UploadedDishImage } from './dish-image-storage.service';

const dishInclude = {
  dietaryTags: { include: { tag: true } },
} satisfies Prisma.DishInclude;

@Injectable()
export class MenusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dishImageStorage: DishImageStorageService,
  ) {}

  async getMenu(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId, status: 'active' },
    });
    if (!restaurant) throw new NotFoundException('Restaurante no encontrado');

    const categories = await this.prisma.menuCategory.findMany({
      where: { restaurantId },
      orderBy: { displayOrder: 'asc' },
      include: {
        dishes: {
          where: { isAvailable: true },
          orderBy: { createdAt: 'asc' },
          include: dishInclude,
        },
      },
    });

    return {
      restaurantId,
      restaurantName: restaurant.name,
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        displayOrder: c.displayOrder,
        dishes: c.dishes.map((d) => this.serializeDish(d)),
      })),
    };
  }

  async createCategory(
    restaurantId: string,
    userId: string,
    role: string,
    dto: CreateCategoryDto,
  ) {
    await this.requireOwnedRestaurant(restaurantId, userId, role);
    return this.prisma.menuCategory.create({
      data: {
        restaurantId,
        name: dto.name,
        displayOrder: dto.displayOrder ?? 0,
      },
    });
  }

  async updateCategory(
    categoryId: number,
    userId: string,
    role: string,
    dto: CreateCategoryDto,
  ) {
    const category = await this.requireOwnedCategory(categoryId, userId, role);
    return this.prisma.menuCategory.update({
      where: { id: category.id },
      data: {
        name: dto.name,
        displayOrder: dto.displayOrder,
      },
    });
  }

  async deleteCategory(categoryId: number, userId: string, role: string) {
    const deleted = await this.withDishImageLock(async (tx) => {
      const category = await tx.menuCategory.findUnique({
        where: { id: categoryId },
        include: { restaurant: true },
      });
      if (!category) throw new NotFoundException('Categoría no encontrada');
      this.assertCategoryOwner(category, userId, role);
      const dishes = await tx.dish.findMany({
        where: { categoryId: category.id },
        select: { imageUrl: true },
      });
      await tx.menuCategory.delete({ where: { id: category.id } });
      return {
        restaurantId: category.restaurantId,
        imageUrls: dishes.map((dish) => dish.imageUrl),
      };
    });
    const cleanupWarnings = await this.cleanupAfterDeletion(deleted.restaurantId, deleted.imageUrls);
    return { ok: true, cleanupWarnings };
  }

  async createDish(categoryId: number, userId: string, role: string, dto: CreateDishDto) {
    return this.withDishImageLock(async (tx) => {
      const category = await tx.menuCategory.findUnique({
        where: { id: categoryId },
        include: { restaurant: true },
      });
      if (!category) throw new NotFoundException('Categoría no encontrada');
      this.assertCategoryOwner(category, userId, role);
      if (dto.imageUrl !== undefined) {
        await this.dishImageStorage.assertOwnedImageUrl(category.restaurantId, dto.imageUrl, tx);
      }
      const dish = await tx.dish.create({
        data: {
          categoryId: category.id,
          name: dto.name,
          description: dto.description,
          price: dto.price,
          currency: dto.currency ?? 'MXN',
          imageUrl: dto.imageUrl,
          isAvailable: dto.isAvailable ?? true,
          dietaryTags: dto.dietaryTagIds?.length
            ? { create: dto.dietaryTagIds.map((tagId) => ({ tagId })) }
            : undefined,
        },
        include: dishInclude,
      });
      return this.serializeDish(dish);
    });
  }

  async updateDish(dishId: string, userId: string, role: string, dto: CreateDishDto) {
    return this.withDishImageLock(async (tx) => {
      const dish = await tx.dish.findUnique({
        where: { id: dishId },
        include: { category: { include: { restaurant: true } } },
      });
      if (!dish) throw new NotFoundException('Platillo no encontrado');
      this.assertDishOwner(dish, userId, role);
      if (dto.imageUrl !== undefined) {
        const unchangedLegacyUrl =
          dto.imageUrl === dish.imageUrl && !this.dishImageStorage.isKartaBucketUrl(dto.imageUrl);
        if (!unchangedLegacyUrl) {
          await this.dishImageStorage.assertOwnedImageUrl(dish.category.restaurantId, dto.imageUrl, tx);
        }
      }

      if (dto.dietaryTagIds) {
        await tx.dishDietaryTag.deleteMany({ where: { dishId: dish.id } });
        if (dto.dietaryTagIds.length) {
          await tx.dishDietaryTag.createMany({
            data: dto.dietaryTagIds.map((tagId) => ({ dishId: dish.id, tagId })),
          });
        }
      }

      const updated = await tx.dish.update({
        where: { id: dish.id },
        data: {
          name: dto.name,
          description: dto.description,
          price: dto.price,
          currency: dto.currency,
          imageUrl: dto.imageUrl,
          isAvailable: dto.isAvailable,
        },
        include: dishInclude,
      });
      return this.serializeDish(updated);
    });
  }

  async deleteDish(dishId: string, userId: string, role: string) {
    const deleted = await this.withDishImageLock(async (tx) => {
      const dish = await tx.dish.findUnique({
        where: { id: dishId },
        include: { category: { include: { restaurant: true } } },
      });
      if (!dish) throw new NotFoundException('Platillo no encontrado');
      this.assertDishOwner(dish, userId, role);
      await tx.dish.delete({ where: { id: dish.id } });
      return { restaurantId: dish.category.restaurantId, imageUrls: [dish.imageUrl] };
    });
    const cleanupWarnings = await this.cleanupAfterDeletion(deleted.restaurantId, deleted.imageUrls);
    return { ok: true, cleanupWarnings };
  }

  async uploadDishImage(
    categoryId: number,
    userId: string,
    role: string,
    file: UploadedDishImage,
  ) {
    const category = await this.requireOwnedCategory(categoryId, userId, role);
    return this.dishImageStorage.upload(category.restaurantId, file);
  }

  async deleteDishImage(categoryId: number, userId: string, role: string, imageUrl: string) {
    return this.withDishImageLock(async (tx) => {
      const category = await tx.menuCategory.findUnique({
        where: { id: categoryId },
        include: { restaurant: true },
      });
      if (!category) throw new NotFoundException('Categoría no encontrada');
      this.assertCategoryOwner(category, userId, role);
      const referencedDish = await tx.dish.findFirst({
        where: { imageUrl },
        select: { id: true },
      });
      if (referencedDish) return { ok: true, deleted: false };
      return this.dishImageStorage.deleteIfOwnedImage(category.restaurantId, imageUrl, tx);
    });
  }

  private async cleanupUnusedDishImages(
    tx: Prisma.TransactionClient,
    restaurantId: string,
    imageUrls: (string | null)[],
  ) {
    const uniqueUrls = [...new Set(imageUrls.filter((url): url is string => Boolean(url)))];
    if (!uniqueUrls.length) return [];

    const remainingDishes = await tx.dish.findMany({
      where: { imageUrl: { in: uniqueUrls } },
      select: { imageUrl: true },
    });
    const remainingUrls = new Set(
      remainingDishes.map((dish) => dish.imageUrl).filter((url): url is string => Boolean(url)),
    );

    const cleanupWarnings: string[] = [];
    for (const imageUrl of uniqueUrls) {
      if (remainingUrls.has(imageUrl)) continue;
      try {
        await this.dishImageStorage.deleteIfOwnedImage(restaurantId, imageUrl, tx);
      } catch (error) {
        cleanupWarnings.push(this.getCleanupErrorMessage(error));
      }
    }
    return cleanupWarnings;
  }

  private async cleanupAfterDeletion(restaurantId: string, imageUrls: (string | null)[]) {
    try {
      return await this.withDishImageLock((tx) =>
        this.cleanupUnusedDishImages(tx, restaurantId, imageUrls),
      );
    } catch {
      return ['No se pudo confirmar la limpieza de Storage; revisa estas imágenes más tarde.'];
    }
  }

  private async withDishImageLock<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(
      async (tx) => {
        // Shared KART/DISH lock serializes every database reference change and its Storage cleanup.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(1262574164, 1145652040)`;
        return work(tx);
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
  }

  private assertCategoryOwner(
    category: { restaurant: { ownerId: string | null } },
    userId: string,
    role: string,
  ) {
    if (role !== 'admin' && category.restaurant.ownerId !== userId) {
      throw new ForbiddenException('No eres el dueño de este restaurante');
    }
  }

  private assertDishOwner(
    dish: { category: { restaurant: { ownerId: string | null } } },
    userId: string,
    role: string,
  ) {
    if (role !== 'admin' && dish.category.restaurant.ownerId !== userId) {
      throw new ForbiddenException('No eres el dueño de este restaurante');
    }
  }

  private getCleanupErrorMessage(error: unknown) {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (typeof response === 'string') return response;
      if (typeof response === 'object' && response !== null && 'message' in response) {
        const message = response.message;
        if (typeof message === 'string') return message;
        if (Array.isArray(message)) return message.join(', ');
      }
    }
    return 'No se pudo eliminar una imagen de Supabase Storage.';
  }

  private serializeDish(dish: Prisma.DishGetPayload<{ include: typeof dishInclude }>) {
    return {
      id: dish.id,
      categoryId: dish.categoryId,
      name: dish.name,
      description: dish.description,
      price: toNumber(dish.price),
      currency: dish.currency,
      imageUrl: dish.imageUrl,
      isAvailable: dish.isAvailable,
      dietaryTags: dish.dietaryTags.map((t) => t.tag),
    };
  }

  private async requireOwnedRestaurant(restaurantId: string, userId: string, role: string) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurante no encontrado');
    if (role !== 'admin' && restaurant.ownerId !== userId) {
      throw new ForbiddenException('No eres el dueño de este restaurante');
    }
    return restaurant;
  }

  private async requireOwnedCategory(categoryId: number, userId: string, role: string) {
    const category = await this.prisma.menuCategory.findUnique({
      where: { id: categoryId },
      include: { restaurant: true },
    });
    if (!category) throw new NotFoundException('Categoría no encontrada');
    if (role !== 'admin' && category.restaurant.ownerId !== userId) {
      throw new ForbiddenException('No eres el dueño de este restaurante');
    }
    return category;
  }

  private async requireOwnedDish(dishId: string, userId: string, role: string) {
    const dish = await this.prisma.dish.findUnique({
      where: { id: dishId },
      include: { category: { include: { restaurant: true } } },
    });
    if (!dish) throw new NotFoundException('Platillo no encontrado');
    if (role !== 'admin' && dish.category.restaurant.ownerId !== userId) {
      throw new ForbiddenException('No eres el dueño de este restaurante');
    }
    return dish;
  }
}
