import Link from "next/link";

export default function SignupCta() {
  return (
    <section className="border-t border-border">
      <div className="relative overflow-hidden">
        <div className="hero-atmosphere absolute inset-0" />
        <div className="grain absolute inset-0" />
        <div className="relative mx-auto max-w-5xl px-6 py-28 md:py-36 text-center">
          <p className="eyebrow">Free for everyone</p>
          <h2 className="statement mt-6 text-5xl uppercase sm:text-6xl md:text-7xl">
            Claim your
            <br />
            seat.
          </h2>
          <p className="thin mx-auto mt-7 max-w-md text-lg text-muted">
            Create an account. Choose Trader or Viewer. The arena is open.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className="rounded-full bg-accent px-7 py-3.5 text-sm font-semibold text-black transition-opacity hover:opacity-90"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Sign up free
            </Link>
            <Link
              href="#how-it-works"
              className="rounded-full border border-border px-7 py-3.5 text-sm font-medium transition-colors hover:bg-white/5"
              style={{ fontFamily: "var(--font-display)" }}
            >
              See how it works
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
