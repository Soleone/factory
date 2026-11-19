/** The favicon drawn inline, so its windows can light up in turn while the factory works. */
export function Logo({ working }: { working: boolean }) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={32}
      height={32}
      aria-hidden
      className={working ? "logo-working" : undefined}
    >
      <rect width="48" height="48" rx="10.5" className="logo-tile" />
      <g
        transform="translate(6 6) scale(1.5)"
        fill="none"
        className="logo-ink"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5a.5.5 0 0 0-.769-.422l-4.462 2.844A.5.5 0 0 1 15 10.5v-2a.5.5 0 0 0-.769-.422L9.77 10.922A.5.5 0 0 1 9 10.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" />
        <path className="logo-window" d="M8 16h.01" />
        <path className="logo-window" d="M12 16h.01" />
        <path className="logo-window" d="M16 16h.01" />
      </g>
    </svg>
  );
}
