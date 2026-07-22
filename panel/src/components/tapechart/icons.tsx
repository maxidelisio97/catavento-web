// Both icons are always paired with a visible/aria-labelled cue elsewhere
// (see TapeGrid.tsx) — SPEC § 6C.6: neither saldo pendente nor fragmentação
// may rely on color alone.
export function BalanceDueIcon() {
  return (
    <svg viewBox="0 0 20 20" width={12} height={12} aria-hidden="true" fill="currentColor">
      <circle cx={10} cy={10} r={8} fillOpacity={0.25} />
      <path d="M10 5.5v9M7.5 8c0-1 .9-1.8 2.5-1.8s2.5.8 2.5 1.6c0 2.2-5 1-5 3.2 0 .8 1 1.6 2.5 1.6s2.5-.8 2.5-1.8" stroke="currentColor" strokeWidth={1.3} fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function FragmentedIcon() {
  return (
    <svg viewBox="0 0 20 20" width={12} height={12} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M8 12l4-4" />
      <path d="M7 6.5H5a3 3 0 0 0 0 6h1" />
      <path d="M13 13.5h2a3 3 0 0 0 0-6h-1" />
    </svg>
  );
}
