import Link from "next/link";
import { Stipple } from "@/components/stipple";

export default function NotFound() {
  return (
    <div className="mx-auto mt-20 max-w-md text-center">
      <Stipple name="constantine" className="mx-auto mb-8 w-48" sizes="192px" />
      <p className="display text-5xl font-extrabold">404</p>
      <p className="mt-2 text-ink-2">This page doesn&apos;t exist, or it moved.</p>
      <Link href="/" className="rounded-full mt-6 inline-flex h-11 items-center bg-sand-2 px-5 hover:bg-sand-2">
        Back to the floor
      </Link>
    </div>
  );
}
