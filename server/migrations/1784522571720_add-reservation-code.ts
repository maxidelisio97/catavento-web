import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('reservations', {
    // Public reference code, e.g. "8 chars alfanuméricos en mayúscula sin
    // ambiguos (sin 0/O/1/I)". Nullable: existing test rows never had one;
    // every reservation the API creates from now on always sets it.
    code: { type: 'text', unique: true },
  });
}
