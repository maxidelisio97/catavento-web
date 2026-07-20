import { randomInt } from 'node:crypto';

// Excludes 0/O and 1/I on purpose (spec: "sin ambiguos").
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

/** Public reservation reference code, e.g. "8K4XQPN2". */
export function generateReservationCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}
