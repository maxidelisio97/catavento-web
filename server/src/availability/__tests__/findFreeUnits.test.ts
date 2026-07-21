import { describe, expect, it } from 'vitest';
import { findFreeUnits, type RoomUnit, type UnitReservation } from '../findFreeUnits.js';

const units: RoomUnit[] = [
  { id: 1, label: '101' },
  { id: 2, label: '102' },
  { id: 3, label: '103' },
];

describe('findFreeUnits', () => {
  it('returns all units, sorted by label, when there are no reservations', () => {
    const free = findFreeUnits(units, [], '2026-08-10', '2026-08-13');
    expect(free.map((u) => u.label)).toEqual(['101', '102', '103']);
  });

  it('excludes a unit with any overlapping reservation', () => {
    const unitReservations: UnitReservation[] = [{ roomUnitId: 2, checkIn: '2026-08-11', checkOut: '2026-08-12' }];
    const free = findFreeUnits(units, unitReservations, '2026-08-10', '2026-08-13');
    expect(free.map((u) => u.id)).toEqual([1, 3]);
  });

  it('does not exclude a unit whose reservation ends exactly at checkIn or starts exactly at checkOut', () => {
    const unitReservations: UnitReservation[] = [
      { roomUnitId: 1, checkIn: '2026-08-08', checkOut: '2026-08-10' }, // ends at checkIn — no overlap
      { roomUnitId: 3, checkIn: '2026-08-13', checkOut: '2026-08-15' }, // starts at checkOut — no overlap
    ];
    const free = findFreeUnits(units, unitReservations, '2026-08-10', '2026-08-13');
    expect(free.map((u) => u.id).sort()).toEqual([1, 2, 3]);
  });

  it('sorts same-length labels correctly, including a false-fragmentation scenario (spec test 4)', () => {
    // Unit A occupied on the first night of the requested range, unit B
    // occupied on the last night. Naive per-night aggregate counting alone
    // would say "1 free" every night (there are 2 units), but NEITHER unit
    // is actually free for the whole range — this is the exact regression
    // scenario from SPEC-modulo-5-unidades-fisicas.md § "Alcance".
    const twoUnits: RoomUnit[] = [
      { id: 10, label: '101' },
      { id: 11, label: '102' },
    ];
    const unitReservations: UnitReservation[] = [
      { roomUnitId: 10, checkIn: '2026-08-10', checkOut: '2026-08-11' }, // occupies night 1
      { roomUnitId: 11, checkIn: '2026-08-12', checkOut: '2026-08-13' }, // occupies night 3
    ];

    const free = findFreeUnits(twoUnits, unitReservations, '2026-08-10', '2026-08-13');
    expect(free).toEqual([]);
  });

  it('label sort is ascending string order (documented: valid because labels within a type share length)', () => {
    const shuffled: RoomUnit[] = [
      { id: 3, label: '103' },
      { id: 1, label: '101' },
      { id: 2, label: '102' },
    ];
    const free = findFreeUnits(shuffled, [], '2026-08-10', '2026-08-11');
    expect(free.map((u) => u.label)).toEqual(['101', '102', '103']);
  });
});
