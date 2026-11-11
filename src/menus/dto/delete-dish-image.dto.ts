import { IsUrl, MaxLength } from 'class-validator';

export class DeleteDishImageDto {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  imageUrl: string;
}
