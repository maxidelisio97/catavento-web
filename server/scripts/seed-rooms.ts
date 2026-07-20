import { db } from '../src/db/client.js';

interface RoomSeed {
  name: string;
  capacity: number;
  petsAllowed: boolean;
  defaultMinStay: number;
  occupancy: number;
  weekdayCents: number;
  weekendCents: number;
}

// Seed data confirmed 2026-07-17 (see SPEC-modulo-1-cuartos-y-tarifas.md).
const rooms: RoomSeed[] = [
  {
    name: 'Casal',
    capacity: 2,
    petsAllowed: false,
    defaultMinStay: 1,
    occupancy: 2,
    weekdayCents: 18000,
    weekendCents: 22000,
  },
  {
    name: 'Triplo',
    capacity: 3,
    petsAllowed: true,
    defaultMinStay: 1,
    occupancy: 3,
    weekdayCents: 20000,
    weekendCents: 25000,
  },
  {
    name: 'Quádruplo',
    capacity: 4,
    petsAllowed: true,
    defaultMinStay: 1,
    occupancy: 4,
    weekdayCents: 23000,
    weekendCents: 30000,
  },
];

async function seed(): Promise<void> {
  for (const room of rooms) {
    const upsertedRoom = await db
      .insertInto('rooms')
      .values({
        name: room.name,
        capacity: room.capacity,
        pets_allowed: room.petsAllowed,
        default_min_stay: room.defaultMinStay,
      })
      .onConflict((oc) =>
        oc.column('name').doUpdateSet({
          capacity: room.capacity,
          pets_allowed: room.petsAllowed,
          default_min_stay: room.defaultMinStay,
        }),
      )
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await db
      .insertInto('room_rates')
      .values({
        room_id: upsertedRoom.id,
        occupancy: room.occupancy,
        weekday_cents: room.weekdayCents,
        weekend_cents: room.weekendCents,
      })
      .onConflict((oc) =>
        oc.columns(['room_id', 'occupancy']).doUpdateSet({
          weekday_cents: room.weekdayCents,
          weekend_cents: room.weekendCents,
        }),
      )
      .execute();

    console.log(`Seeded room "${room.name}" (id ${upsertedRoom.id})`);
  }
}

seed()
  .then(() => db.destroy())
  .catch((err) => {
    console.error(err);
    return db.destroy().finally(() => process.exit(1));
  });
