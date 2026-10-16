"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import Navbar from "@/components/Navbar";

const TradeTerminal = dynamic(() => import("@/components/TradeTerminal"), {
  ssr: false,
  loading: () => (
    <>
      <Navbar />
      <main className="min-h-screen bg-background pt-24 px-4">
        <div className="mx-auto max-w-[1600px] animate-pulse space-y-4">
          <div className="h-10 w-full max-w-xl rounded-full bg-white/5" />
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="h-[420px] rounded-lg bg-white/5" />
            <div className="h-[420px] rounded-lg bg-white/5" />
          </div>
          <p className="text-sm text-muted">Opening trade terminal…</p>
        </div>
      </main>
    </>
  ),
});

export default function TradePage() {
  return (
    <Suspense
      fallback={
        <>
          <Navbar />
          <main className="pt-32 px-6 text-muted">Loading terminal…</main>
        </>
      }
    >
      <TradeTerminal />
    </Suspense>
  );
}
