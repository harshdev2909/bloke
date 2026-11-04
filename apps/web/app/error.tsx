"use client";

import Link from "next/link";
import { Art } from "@/components/art";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto mt-20 max-w-md text-center">
      <Art slot="empty" className="mx-auto mb-8 w-48" sizes="192px" />
      <h1 className="display text-3xl font-bold">Something broke on our side</h1>
      <p className="mt-3 text-ink-2">Your funds are on chain and unaffected. Try again, or head back to the floor.</p>
      <div className="mt-8 flex justify-center gap-3">
        <button type="button" onClick={reset} className="btn btn-ink">
          Try again
        </button>
        <Link href="/" className="btn btn-quiet">
          Back to the floor
        </Link>
      </div>
    </div>
  );
}
