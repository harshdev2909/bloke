"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark, Wordmark } from "./logo";
import { MonadMark } from "./monad-mark";
import { WalletButton } from "./wallet-button";
import { cn } from "@/lib/cn";

const LINKS = [
  { href: "/", label: "Floor" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/pool", label: "Pool" },
  { href: "/raise", label: "Raise" },
  { href: "/rep", label: "Rep" },
];

function useScrolled() {
  const [s, setS] = useState(false);
  useEffect(() => {
    const on = () => setS(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return s;
}

export function Nav() {
  const path = usePathname();
  const scrolled = useScrolled();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <header className={cn("sticky top-0 z-40 bg-canvas/90 backdrop-blur-md transition-[box-shadow] duration-150", scrolled && "shadow-[0_1px_0_#E4E0DC]")}>
      <nav aria-label="Main" className="mx-auto grid h-[68px] w-[min(1200px,calc(100%-40px))] grid-cols-[1fr_auto] items-center md:grid-cols-[1fr_auto_1fr]">
        <Link href="/" className="flex w-fit items-center gap-2.5" aria-label="BLOKE home">
          <LogoMark />
          <Wordmark />
        </Link>
        <ul className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active(l.href) ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 items-center rounded-full px-4 text-[15px] transition-colors duration-100 ease-out",
                  active(l.href) ? "bg-sand text-ink" : "text-ink-3 hover:text-ink",
                )}
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-end gap-2">
          <Link
            href="/me"
            aria-current={active("/me") ? "page" : undefined}
            className={cn("hidden h-10 items-center rounded-full px-4 text-[15px] transition-colors duration-100 sm:inline-flex", active("/me") ? "bg-sand text-ink" : "text-ink-3 hover:text-ink")}
          >
            Get tUSDC
          </Link>
          <WalletButton />
        </div>
      </nav>
      {/* Mobile: bottom bar at thumb reach */}
      <ul className="fixed inset-x-3 bottom-3 z-40 flex h-16 items-center justify-around rounded-full bg-ink px-2 shadow-[0_10px_30px_-10px_rgb(14_16_15/0.4)] md:hidden">
        {[...LINKS, { href: "/me", label: "Me" }].map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              aria-current={active(l.href) ? "page" : undefined}
              className={cn("inline-flex h-11 items-center rounded-full px-3.5 text-sm", active(l.href) ? "bg-canvas text-ink" : "text-canvas/80")}
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </header>
  );
}

const FOOT = [
  ["Floor", "/"],
  ["Portfolio", "/portfolio"],
  ["Pool", "/pool"],
  ["Raise", "/raise"],
  ["Rep", "/rep"],
  ["Get tUSDC", "/me"],
  ["Status", "/status"],
] as const;

/** Curved ink panel, inset from the page edges. Only what someone would act on. */
export function Footer() {
  return (
    <footer className="mx-3 mb-24 mt-40 overflow-hidden rounded-[48px] bg-ink text-canvas md:mx-5 md:mb-5">
      <div className="mx-auto flex w-[min(1200px,calc(100%-48px))] flex-col gap-12 py-14 md:flex-row md:items-end md:justify-between md:py-16">
        <div>
          <Link href="/" className="flex w-fit items-center gap-3" aria-label="BLOKE home">
            <svg viewBox="0 0 32 32" className="size-10" aria-hidden>
              <circle cx="16" cy="16" r="15" fill="#FBFAF9" />
              <path d="M11 7v18" stroke="#0E100F" strokeWidth="2.6" strokeLinecap="round" />
              <path d="M11 13.5c7.5 0 10.5 1.8 10.5 5.6 0 3.9-3 5.9-10.5 5.9" fill="none" stroke="#836EF9" strokeWidth="2.6" strokeLinecap="round" />
              <circle cx="22.5" cy="9" r="1.8" fill="#0E100F" />
            </svg>
            <span className="display text-[44px] font-bold leading-none md:text-[64px]">bloke</span>
          </Link>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-2">
            {FOOT.map(([label, href]) => (
              <li key={label}>
                <Link href={href} className="inline-flex h-11 items-center rounded-full bg-canvas/8 px-5 text-sm text-canvas/90 transition-colors duration-100 hover:bg-canvas hover:text-ink">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="mx-auto flex w-[min(1200px,calc(100%-48px))] flex-wrap items-center justify-between gap-4 border-t border-canvas/12 py-6 text-[13px] text-canvas/60">
        <p>Testnet. tUSDC has no value. Unaudited.</p>
        <a href="https://monad.xyz" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full bg-canvas px-3 py-1.5 text-ink transition-opacity duration-100 hover:opacity-90">
          <MonadMark className="size-4" />
          Built on Monad
        </a>
      </div>
    </footer>
  );
}
