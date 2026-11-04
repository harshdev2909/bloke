/** Mark: a "b" drawn as one orbit around a core — people as bodies in motion. */
export function LogoMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <circle cx="16" cy="16" r="15" fill="#0E100F" />
      <path d="M11 7v18" stroke="#FBFAF9" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M11 13.5c7.5 0 10.5 1.8 10.5 5.6 0 3.9-3 5.9-10.5 5.9" fill="none" stroke="#836EF9" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="22.5" cy="9" r="1.8" fill="#FBFAF9" />
    </svg>
  );
}

export function Wordmark() {
  return <span className="display text-[21px] font-bold leading-none">bloke</span>;
}
