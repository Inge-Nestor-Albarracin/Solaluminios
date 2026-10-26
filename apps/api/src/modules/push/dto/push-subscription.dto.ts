import { Type } from 'class-transformer';
import { IsNotEmpty, IsObject, IsString, MaxLength, ValidateNested } from 'class-validator';
import { MAX_ENDPOINT_LENGTH } from '../push-endpoint.js';

// Shape of PushSubscription.toJSON() in the browser (expirationTime is not
// sent). Host allow-list and key lengths are checked by the service.
export class PushKeysDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  p256dh!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  auth!: string;
}

export class PushSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ENDPOINT_LENGTH)
  endpoint!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;
}

export class PushEndpointDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ENDPOINT_LENGTH)
  endpoint!: string;
}
