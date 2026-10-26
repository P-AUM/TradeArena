import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import HowItWorks from "@/components/HowItWorks";
import Features from "@/components/Features";
import SignupCta from "@/components/SignupCta";

export default function Home() {
  return (
    <>
      <Navbar />

      <main className="flex-1">
        {/* -------- Hero: brand + headline + line + CTAs + full-bleed atmosphere -------- */}
        <section className="relative min-h-dvh">
          <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
            <div className="hero-atmosphere absolute inset-0" />
            <div className="grain absolute inset-0" />
          </div>

          {/* Dominant visual plane — monolith shadow field (kept lower so copy breathes) */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[42%] overflow-hidden opacity-90"
            aria-hidden="true"
          >
            <div className="absolute left-1/2 bottom-[8%] h-[36vmin] w-[28vmin] -translate-x-1/2 bg-[#0e100f]"
              style={{
                clipPath: "polygon(18% 100%, 32% 0%, 68% 0%, 82% 100%)",
                boxShadow: "0 0 120px rgba(61,255,181,0.12)",
              }}
            />
            <div className="absolute left-1/2 bottom-[8%] h-[28vmin] w-[3px] -translate-x-1/2 bg-foreground/70" />
            <div
              className="absolute inset-x-0 bottom-0 h-40"
              style={{
                background:
                  "linear-gradient(to top, #050505 10%, rgba(61,255,181,0.06) 45%, transparent 100%)",
              }}
            />
          </div>

          <div className="relative mx-auto flex min-h-dvh max-w-5xl flex-col items-center justify-center px-6 pb-36 pt-36 text-center md:pb-44 md:pt-40">
            <p
              className="statement text-2xl uppercase tracking-tight text-foreground sm:text-3xl"
              style={{ letterSpacing: "-0.02em" }}
            >
              TradeArena
            </p>

            <h1 className="statement mt-8 max-w-full break-words text-5xl uppercase leading-[1.08] sm:text-7xl md:mt-10 md:text-8xl md:leading-[1.06]">
              Trade in
              <br />
              public.
            </h1>

            <p className="thin mx-auto mt-10 max-w-lg text-base leading-relaxed text-muted md:mt-12 md:text-lg md:leading-8">
              Paper-trade crypto and forex. Viewers follow every move. Climb the
              boards on skill alone.
            </p>

            <div className="mt-12 flex flex-wrap items-center justify-center gap-4 md:mt-14">
              <Link
                href="/signup"
                className="rounded-full bg-foreground px-6 py-3.5 text-sm font-medium text-black transition-opacity hover:opacity-90"
                style={{ fontFamily: "var(--font-display)" }}
              >
                Enter Arena
              </Link>
              <Link
                href="#how-it-works"
                className="rounded-full border border-border px-6 py-3.5 text-sm font-medium transition-colors hover:bg-white/5"
                style={{ fontFamily: "var(--font-display)" }}
              >
                How it works
              </Link>
            </div>
          </div>
        </section>

        <HowItWorks />
        <Features />
        <SignupCta />
      </main>

      <Footer />
    </>
  );
}
