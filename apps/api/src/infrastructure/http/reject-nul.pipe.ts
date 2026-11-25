import { BadRequestException, type PipeTransform } from '@nestjs/common';

// PostgreSQL text can never hold the NUL character (U+0000): a value with one
// made the database fail and the API answer 500. Every route parameter, query
// and body is checked up front and refused with a 400 (global pipe, before
// validation). Nothing else about the value changes.
const MAX_DEPTH = 32;

export function hasNul(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH || ArrayBuffer.isView(value)) return false;
  if (Array.isArray(value)) return value.some((item) => hasNul(item, depth + 1));
  return Object.entries(value).some(([key, item]) => key.includes('\u0000') || hasNul(item, depth + 1));
}

export class RejectNulPipe implements PipeTransform {
  transform(value: unknown) {
    if (hasNul(value)) throw new BadRequestException('El texto contiene un carácter no permitido (carácter nulo)');
    return value;
  }
}
