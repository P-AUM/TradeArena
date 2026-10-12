"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { useAuth } from "@/lib/auth";
import type { Role } from "@/lib/api";

export default function SignupPage() {
  const { signup, user } = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("trader");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (user) router.replace("/dashboard");
  }, [user, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await signup({ username, email, password, role });
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <section className="relative overflow-hidden">
          <div className="hero-atmosphere absolute inset-0" />
          <div className="relative mx-auto max-w-md px-6 pt-40 pb-24">
            <p className="eyebrow">Sign up</p>
            <h1 className="statement mt-5 text-5xl uppercase sm:text-6xl">
              Claim your
              <br />
              seat.
            </h1>
            <p className="thin mt-6 text-base text-muted">
              Email + password for now. Role is locked after you choose.
            </p>

            <form onSubmit={onSubmit} className="mt-10 space-y-5">
              <label className="block">
                <span className="eyebrow">Username</span>
                <input
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-accent/50"
                  autoComplete="username"
                />
              </label>
              <label className="block">
                <span className="eyebrow">Email</span>
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-accent/50"
                  autoComplete="email"
                />
              </label>
              <label className="block">
                <span className="eyebrow">Password</span>
                <input
                  required
                  type="password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-accent/50"
                  autoComplete="new-password"
                />
              </label>

              <fieldset>
                <legend className="eyebrow">Role (locked)</legend>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {(
                    [
                      { id: "trader", label: "Trader" },
                      { id: "viewer", label: "Viewer" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setRole(opt.id)}
                      className={`rounded-lg border px-4 py-3 text-sm transition-colors ${
                        role === opt.id
                          ? "border-accent bg-accent/10 text-foreground"
                          : "border-border text-muted hover:bg-white/5"
                      }`}
                      style={{ fontFamily: "var(--font-display)" }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </fieldset>

              {error ? (
                <p className="text-sm text-danger" role="alert">
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={pending}
                className="w-full rounded-full bg-accent px-6 py-3.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {pending ? "Creating…" : "Create account"}
              </button>
            </form>

            <p className="mt-8 text-sm text-muted">
              Already have an account?{" "}
              <Link href="/login" className="text-foreground hover:underline">
                Log in
              </Link>
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
