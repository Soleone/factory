const WINDOW = { y: 14.2, width: 3, height: 3.4, rx: 0.6 };

/** The favicon drawn inline. While the factory works, its windows pop one after another. */
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
      <g transform="translate(6 6) scale(1.5)">
        <g
          fill="none"
          className="logo-ink"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5a.5.5 0 0 0-.769-.422l-4.462 2.844A.5.5 0 0 1 15 10.5v-2a.5.5 0 0 0-.769-.422L9.77 10.922A.5.5 0 0 1 9 10.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" />
        </g>
        <g className="logo-ink-fill">
          {[6.5, 10.5, 14.5].map((x) => (
            <rect key={x} className="logo-window" x={x} {...WINDOW} />
          ))}
        </g>
      </g>
    </svg>
  );
}
