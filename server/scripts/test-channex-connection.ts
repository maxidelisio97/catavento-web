import { config } from '../src/config.js';
import { getProperty, listRoomTypes } from '../src/channex/channexClient.js';

/**
 * Manual, one-off verification for SPEC-modulo-12A entrega 1 — no panel UI
 * exists yet (that's entrega 3). Bypasses the DB/config table entirely: the
 * property_id is passed on the command line, not read from channex_config,
 * so this works before any panel config row exists.
 *
 * Usage: tsx scripts/test-channex-connection.ts <propertyId>
 */
const propertyId = process.argv[2];

if (!propertyId) {
  console.error('Usage: tsx scripts/test-channex-connection.ts <propertyId>');
  process.exit(1);
}

if (config.channex.env !== 'staging') {
  console.error('Refusing to run: CHANNEX_ENV is not staging.');
  process.exit(1);
}

console.log(`Connecting to ${config.channex.baseUrl} ...`);

const property = await getProperty(propertyId);
console.log('Property:', JSON.stringify(property, null, 2));

const roomTypes = await listRoomTypes(propertyId);
console.log('Room types:', JSON.stringify(roomTypes, null, 2));
