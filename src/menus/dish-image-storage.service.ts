import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const BUCKET = 'karta-dish-images';
const MAX_FILE_SIZE = 5 * 1024 * 1024;
export type UploadedDishImage = { buffer: Buffer; size: number; mimetype: string };
const IMAGE_TYPES = {
  'image/jpeg': { extension: 'jpg', matches: (data: Buffer) => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff },
  'image/png': {
    extension: 'png',
    matches: (data: Buffer) => data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  'image/webp': {
    extension: 'webp',
    matches: (data: Buffer) =>
      data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP',
  },
} as const;

@Injectable()
export class DishImageStorageService {
  private bucketReady: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async upload(restaurantId: string, file: UploadedDishImage) {
    if (file.size > MAX_FILE_SIZE) {
      throw new PayloadTooLargeException('La imagen debe pesar 5 MB o menos');
    }

    const type = IMAGE_TYPES[file.mimetype as keyof typeof IMAGE_TYPES];
    if (!type || !type.matches(file.buffer)) {
      throw new BadRequestException('Formato no válido. Usa una imagen JPG, PNG o WebP');
    }

    const { baseUrl, serviceKey } = this.getStorageConfig();
    await this.assertNoPublicWritePolicies();
    await this.ensureBucket(baseUrl, serviceKey);

    const objectPath = `${restaurantId}/${randomUUID()}.${type.extension}`;
    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/storage/v1/object/${BUCKET}/${objectPath}`,
        {
          method: 'POST',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': file.mimetype,
            'x-upsert': 'false',
          },
          body: file.buffer as unknown as BodyInit,
        },
      );
    } catch {
      throw new ServiceUnavailableException('No se pudo conectar con Supabase Storage');
    }

    if (!response.ok) {
      throw new InternalServerErrorException('No se pudo guardar la imagen en Supabase Storage');
    }

    return { imageUrl: `${baseUrl}/storage/v1/object/public/${BUCKET}/${objectPath}` };
  }

  async deleteIfOwnedImage(
    restaurantId: string,
    imageUrl: string,
    queryClient: Prisma.TransactionClient,
  ) {
    const { baseUrl, serviceKey } = this.getStorageConfig();
    const objectPath = this.tryGetOwnedObjectPath(imageUrl, restaurantId, baseUrl);
    if (!objectPath) return { ok: true, deleted: false };
    await this.deleteObjectPath(objectPath, baseUrl, serviceKey, queryClient);
    return { ok: true, deleted: true };
  }

  async assertOwnedImageUrl(
    restaurantId: string,
    imageUrl: string,
    queryClient: Prisma.TransactionClient,
  ) {
    const { baseUrl, serviceKey } = this.getStorageConfig();
    const objectPath = this.getOwnedObjectPath(imageUrl, restaurantId, baseUrl);
    await this.assertNoPublicWritePolicies(queryClient);
    let response: Response;
    try {
      response = await fetch(
        `${baseUrl}/storage/v1/object/info/${BUCKET}/${objectPath}`,
        {
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new ServiceUnavailableException('No se pudo verificar la imagen en Supabase Storage');
    }

    if (response.status === 404) {
      throw new BadRequestException('La imagen indicada no existe en el bucket de este restaurante');
    }
    if (!response.ok) {
      throw new InternalServerErrorException('No se pudo verificar la imagen en Supabase Storage');
    }
  }

  isKartaBucketUrl(imageUrl: string) {
    const { baseUrl } = this.getStorageConfig();
    try {
      const supplied = new URL(imageUrl);
      const project = new URL(baseUrl);
      const publicPrefix =
        `${project.pathname.replace(/\/+$/, '')}/storage/v1/object/public/${BUCKET}/`;
      return supplied.origin === project.origin && supplied.pathname.startsWith(publicPrefix);
    } catch {
      return false;
    }
  }

  private async deleteObjectPath(
    objectPath: string,
    baseUrl: string,
    serviceKey: string,
    queryClient: Prisma.TransactionClient,
  ) {
    await this.assertNoPublicWritePolicies(queryClient);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/storage/v1/object/${BUCKET}`, {
        method: 'DELETE',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prefixes: [objectPath] }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo conectar con Supabase Storage para eliminar la imagen');
    }

    if (!response.ok) {
      throw new InternalServerErrorException('No se pudo eliminar la imagen de Supabase Storage');
    }
  }

  private async assertNoPublicWritePolicies(
    queryClient: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    let rlsRows: Array<{ row_security_enabled: boolean }>;
    let policies: Array<{ roles: string[]; cmd: string; qual: string | null; with_check: string | null }>;
    try {
      rlsRows = await queryClient.$queryRaw`
        SELECT relrowsecurity AS row_security_enabled
        FROM pg_class
        WHERE oid = 'storage.objects'::regclass
      `;
      policies = await queryClient.$queryRaw`
        SELECT roles, cmd, qual, with_check
        FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
      `;
    } catch {
      throw new ServiceUnavailableException(
        'No se pudo verificar la seguridad de las políticas de Storage; se bloqueó la operación.',
      );
    }

    if (rlsRows.length !== 1 || !rlsRows[0].row_security_enabled) {
      throw new ServiceUnavailableException(
        'La tabla de Storage no tiene RLS habilitado; se bloqueó la operación.',
      );
    }

    const hasApplicablePublicWrite = policies.some((policy) => {
      const command = policy.cmd.toUpperCase();
      const roles = policy.roles.map((role) => role.toLowerCase());
      const isPublic = roles.includes('public') || roles.includes('anon');
      if (!isPublic || !['INSERT', 'UPDATE', 'DELETE', 'ALL', '*'].includes(command)) return false;

      const usingBuckets = this.getExplicitBuckets(policy.qual);
      const checkBuckets = this.getExplicitBuckets(policy.with_check ?? policy.qual);
      const excludesKarta = (buckets: string[] | null) =>
        buckets !== null && !buckets.includes(BUCKET);

      if (command === 'INSERT') return !excludesKarta(checkBuckets);
      if (command === 'DELETE') return !excludesKarta(usingBuckets);
      if (command === 'UPDATE' || command === 'ALL' || command === '*') {
        // Both existing and resulting rows must be pinned to other bucket(s) to prove safety.
        return !(excludesKarta(usingBuckets) && excludesKarta(checkBuckets));
      }
      return true;
    });

    if (hasApplicablePublicWrite) {
      throw new ServiceUnavailableException(
        'Hay una política anon/public de escritura que podría aplicar a las imágenes de Karta. No se usará el bucket hasta revisar esa política.',
      );
    }
  }

  private getExplicitBuckets(expression: string | null): string[] | null {
    if (!expression) return null;
    let normalized = expression.trim();
    while (normalized.startsWith('(') && normalized.endsWith(')')) {
      normalized = normalized.slice(1, -1).trim();
    }

    const value = String.raw`'((?:[^']|'')*)'(?:\s*::\s*(?:text|character varying))?`;
    const equality = new RegExp(String.raw`^"?bucket_id"?\s*=\s*${value}$`, 'i').exec(normalized);
    if (equality) return [equality[1].replace(/''/g, "'")];

    const inExpression = /^"?bucket_id"?\s+IN\s*\((.*)\)$/i.exec(normalized);
    if (!inExpression) return null;
    const list = inExpression[1];
    const literal = /'((?:[^']|'')*)'(?:\s*::\s*(?:text|character varying))?/gy;
    const buckets: string[] = [];
    let offset = 0;
    while (offset < list.length) {
      while (/\s/.test(list[offset] ?? '')) offset += 1;
      literal.lastIndex = offset;
      const match = literal.exec(list);
      if (!match) return null;
      buckets.push(match[1].replace(/''/g, "'"));
      offset = literal.lastIndex;
      while (/\s/.test(list[offset] ?? '')) offset += 1;
      if (offset === list.length) break;
      if (list[offset] !== ',') return null;
      offset += 1;
    }
    return buckets.length ? buckets : null;
  }

  private getOwnedObjectPath(imageUrl: string, restaurantId: string, baseUrl: string) {
    const path = this.tryGetOwnedObjectPath(imageUrl, restaurantId, baseUrl);
    if (!path) {
      throw new BadRequestException('La URL no es una imagen de Karta perteneciente a este restaurante');
    }
    return path;
  }

  private tryGetOwnedObjectPath(imageUrl: string, restaurantId: string, baseUrl: string): string | null {
    let supplied: URL;
    let project: URL;
    try {
      supplied = new URL(imageUrl);
      project = new URL(baseUrl);
    } catch {
      return null;
    }

    const publicPrefix =
      `${project.pathname.replace(/\/+$/, '')}/storage/v1/object/public/${BUCKET}/`;
    if (
      supplied.origin !== project.origin ||
      supplied.username ||
      supplied.password ||
      supplied.search ||
      supplied.hash ||
      !supplied.pathname.startsWith(publicPrefix)
    ) {
      return null;
    }

    const objectPath = supplied.pathname.slice(publicPrefix.length);
    const uuidFile = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/i;
    if (
      !objectPath.startsWith(`${restaurantId}/`) ||
      !uuidFile.test(objectPath.slice(restaurantId.length + 1))
    ) {
      return null;
    }
    return objectPath;
  }

  private async ensureBucket(baseUrl: string, serviceKey: string) {
    if (!this.bucketReady) {
      this.bucketReady = this.provisionBucket(baseUrl, serviceKey).catch((error: unknown) => {
        this.bucketReady = null;
        throw error;
      });
    }
    await this.bucketReady;
  }

  private async provisionBucket(baseUrl: string, serviceKey: string) {
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    };
    const settings = {
      id: BUCKET,
      name: BUCKET,
      public: true,
      file_size_limit: MAX_FILE_SIZE,
      allowed_mime_types: Object.keys(IMAGE_TYPES),
    };

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/storage/v1/bucket`, {
        method: 'POST',
        headers,
        body: JSON.stringify(settings),
      });
      const duplicateBucket =
        response.status === 409 ||
        (response.status === 400 && /already exists|duplicate/i.test(await response.text()));
      if (duplicateBucket) {
        response = await fetch(`${baseUrl}/storage/v1/bucket/${BUCKET}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            public: true,
            file_size_limit: MAX_FILE_SIZE,
            allowed_mime_types: Object.keys(IMAGE_TYPES),
          }),
        });
      }
    } catch {
      throw new ServiceUnavailableException('No se pudo conectar con Supabase Storage');
    }

    if (!response.ok) {
      throw new InternalServerErrorException('No se pudo preparar el bucket de imágenes de Karta');
    }
  }

  private getStorageConfig() {
    const configuredUrl = this.config.get<string>('SUPABASE_URL')?.trim();
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY')?.trim();
    if (!configuredUrl || !serviceKey) {
      throw new InternalServerErrorException('Falta configurar Supabase Storage en el backend');
    }
    return { baseUrl: configuredUrl.replace(/\/+$/, ''), serviceKey };
  }
}
