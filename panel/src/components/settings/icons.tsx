// SPEC-modulo-8-configuracion.md § 6.7: "fechado" and "cupo reduzido" must be
// distinguishable by shape, not color alone. Same precedent as
// tapechart/icons.tsx's BalanceDueIcon/FragmentedIcon — always paired with a
// visible text/number cue elsewhere (RateOverridesCalendar.tsx).
export function ClosedIcon() {
  return (
    <svg viewBox="0 0 20 20" width={13} height={13} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <rect x={5} y={9} width={10} height={7.5} rx={1.5} />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </svg>
  );
}

export function ReducedUnitsIcon() {
  return (
    <svg viewBox="0 0 20 20" width={13} height={13} aria-hidden="true" fill="currentColor">
      <circle cx={10} cy={10} r={8} fillOpacity={0.22} />
      <path d="M10 2a8 8 0 0 1 0 16z" />
    </svg>
  );
}
