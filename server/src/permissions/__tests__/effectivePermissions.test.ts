import { describe, expect, it } from 'vitest';
import { can, effectivePermissions, type EffectivePermissionInput } from '../effectivePermissions.js';

const ALL_PERMISSIONS = ['reservations.view', 'payments.charge', 'admin.users'] as const;

function input(overrides: Partial<EffectivePermissionInput> = {}): EffectivePermissionInput {
  return {
    roleIsOwner: false,
    rolePermissions: new Set(),
    overrides: new Map(),
    ...overrides,
  };
}

describe('can()', () => {
  it('denies a permission absent from the role, with no override, no owner', () => {
    const result = can(input({ rolePermissions: new Set(['reservations.view']) }), 'payments.charge');
    expect(result).toBe(false);
  });

  it('grants a permission present in the role, with no override', () => {
    const result = can(input({ rolePermissions: new Set(['reservations.view']) }), 'reservations.view');
    expect(result).toBe(true);
  });

  it('an override granting=true adds a permission the role does not have', () => {
    const result = can(
      input({ rolePermissions: new Set(), overrides: new Map([['payments.charge', true]]) }),
      'payments.charge',
    );
    expect(result).toBe(true);
  });

  it('an override granted=false removes a permission the role does have', () => {
    const result = can(
      input({
        rolePermissions: new Set(['payments.charge']),
        overrides: new Map([['payments.charge', false]]),
      }),
      'payments.charge',
    );
    expect(result).toBe(false);
  });

  it('the Dueño (roleIsOwner) can do anything, even a permission absent from rolePermissions', () => {
    const result = can(input({ roleIsOwner: true, rolePermissions: new Set() }), 'admin.roles');
    expect(result).toBe(true);
  });

  // The anti-self-lockout backdoor § 2.4 explicitly worries about: quitting
  // admin.users via an override instead of via the role. A Dueño with
  // granted=false on admin.users must still be able to administer.
  it('a Dueño with an override revoking admin.users can still administer', () => {
    const result = can(
      input({ roleIsOwner: true, overrides: new Map([['admin.users', false]]) }),
      'admin.users',
    );
    expect(result).toBe(true);
  });

  it('a user with no role (empty rolePermissions) and no override has zero permissions', () => {
    const result = can(input(), 'reservations.view');
    expect(result).toBe(false);
  });

  it('a user with no role can still be granted a permission via override', () => {
    const result = can(input({ overrides: new Map([['reservations.view', true]]) }), 'reservations.view');
    expect(result).toBe(true);
  });
});

describe('effectivePermissions()', () => {
  it('returns the full catalog for a Dueño, regardless of rolePermissions/overrides', () => {
    const result = effectivePermissions(
      input({ roleIsOwner: true, overrides: new Map([['admin.users', false]]) }),
      ALL_PERMISSIONS,
    );
    expect(result).toEqual(new Set(ALL_PERMISSIONS));
  });

  it('returns rolePermissions modified by overrides for a non-owner', () => {
    const result = effectivePermissions(
      input({
        rolePermissions: new Set(['reservations.view', 'payments.charge']),
        overrides: new Map([
          ['payments.charge', false],
          ['admin.users', true],
        ]),
      }),
      ALL_PERMISSIONS,
    );
    expect(result).toEqual(new Set(['reservations.view', 'admin.users']));
  });

  it('returns an empty set for a roleless user with no overrides', () => {
    const result = effectivePermissions(input(), ALL_PERMISSIONS);
    expect(result).toEqual(new Set());
  });
});
