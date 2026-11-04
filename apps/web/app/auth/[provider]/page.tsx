"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ApiError } from "@bloke/sdk";
import { api } from "@/lib/api";

/** OAuth return URL: hands code + state to the API, then back to setup. */
function Callback() {
  const { provider } = useParams<{ provider: "github" | "x" }>();
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError(params.get("error_description") ?? "Sign-in was cancelled.");
      return;
    }
    api
      .identityCallback(provider, { code, state })
      .then(() => router.replace("/me"))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Linking failed. Try again."));
  }, [params, provider, router]);
  return (
    <div className="tile mx-auto mt-20 max-w-md p-8 text-center">
      {error ? (
        <>
          <p className="display text-xl font-bold">Couldn&apos;t link your account</p>
          <p className="mt-2 text-ink-2">{error}</p>
          <a href="/me" className="rounded-full mt-6 inline-flex h-11 items-center bg-sand-2 px-5 hover:bg-sand-2">
            Back to setup
          </a>
        </>
      ) : (
        <p className="text-ink-2" role="status">
          Linking your {provider === "github" ? "GitHub" : "X"} account…
        </p>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Callback />
    </Suspense>
  );
}
