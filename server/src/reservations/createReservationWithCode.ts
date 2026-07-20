import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { createReservation, type CreateReservationInput, type CreateReservationResult } from '../availability/createReservation.js';
import { generateReservationCode } from './generateCode.js';

const MAX_CODE_ATTEMPTS = 3;

interface PgUniqueViolation {
  code: string;
  constraint?: string;
}

function isCodeUniqueViolation(err: unknown): err is PgUniqueViolation {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as PgUniqueViolation).code === '23505' &&
    ((err as PgUniqueViolation).constraint?.includes('code') ?? false)
  );
}

/**
 * SPEC-modulo-3-flujo-de-reserva.md § "Endpoints nuevos": wraps módulo 2's
 * createReservation (never reimplemented) with a generated public code.
 * A code collision is astronomically unlikely (32^8 combinations) — the
 * retry here is defensive, not a load-bearing path.
 */
export async function createReservationWithCode(
  db: Kysely<DB>,
  input: Omit<CreateReservationInput, 'code'>,
): Promise<CreateReservationResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    try {
      return await createReservation(db, { ...input, code: generateReservationCode() });
    } catch (err) {
      if (!isCodeUniqueViolation(err)) throw err;
      lastError = err;
    }
  }

  throw lastError;
}
