"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { login, user } = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
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
      await login({ username, password });
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
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
            <p className="eyebrow">Log in</p>
            <h1 className="statement mt-5 text-5xl uppercase sm:text-6xl">
              Welcome
              <br />
              back.
            </h1>
            <p className="thin mt-6 text-base text-muted">
              Use your username or email + password.
            </p>

            <form onSubmit={onSubmit} className="mt-10 space-y-5">
              <label className="block">
                <span className="eyebrow">Username or email</span>
                <input
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-accent/50"
                  autoComplete="username"
                />
              </label>
              <label className="block">
                <span className="eyebrow">Password</span>
                <input
                  required
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-accent/50"
                  autoComplete="current-password"
                />
              </label>

              <div className="flex justify-end">
                <Link
                  href="/forgot-password"
                  className="text-xs text-muted hover:text-foreground"
                >
                  Forgot password?
                </Link>
              </div>

              {error ? (
                <p className="text-sm text-danger" role="alert">
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={pending}
                className="w-full rounded-full bg-foreground px-6 py-3.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {pending ? "Signing in…" : "Log in"}
              </button>
            </form>

            <p className="mt-8 text-sm text-muted">
              New here?{" "}
              <Link href="/signup" className="text-foreground hover:underline">
                Create an account
              </Link>
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
