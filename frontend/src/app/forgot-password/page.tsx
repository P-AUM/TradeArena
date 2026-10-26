"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import PendingButton from "@/components/PendingButton";
import { useImmediatePending } from "@/lib/pending";
import {
  apiForgotPassword,
  apiResetPassword,
  apiVerifyResetCode,
} from "@/lib/api";

type Step = "email" | "code" | "password" | "done";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { pending, startPending, stopPending } = useImmediatePending();

  async function onSendCode(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setMessage(null);
    setDevCode(null);
    startPending();
    try {
      const res = await apiForgotPassword(email);
      setMessage(res.detail);
      if (res.dev_code) {
        setDevCode(res.dev_code);
        setCode(res.dev_code);
      }
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send code");
    } finally {
      stopPending();
    }
  }

  async function onVerifyCode(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setMessage(null);
    startPending();
    try {
      const res = await apiVerifyResetCode({
        email,
        code: code.trim(),
      });
      setMessage(res.detail);
      setStep("password");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      stopPending();
    }
  }

  async function onReset(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setMessage(null);
    if (newPassword !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    startPending();
    try {
      const res = await apiResetPassword({
        email,
        code: code.trim(),
        new_password: newPassword,
      });
      setMessage(res.detail);
      setStep("done");
      setTimeout(() => router.push("/login"), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      stopPending();
    }
  }

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <section className="relative">
          <div
            className="hero-atmosphere pointer-events-none absolute inset-0 overflow-hidden"
            aria-hidden
          />
          <div className="relative mx-auto max-w-md px-6 pt-40 pb-24">
            <p className="eyebrow">Account</p>
            <h1 className="statement mt-5 text-5xl uppercase sm:text-6xl">
              Reset
              <br />
              password.
            </h1>
            <p className="thin mt-6 text-base text-muted">
              {step === "email" &&
                "We email a 6-digit code to your registered address. It expires in 15 minutes."}
              {step === "code" && "Enter the code from your email to continue."}
              {step === "password" && "Code verified. Choose a new password."}
              {step === "done" && "All set."}
            </p>

            {step === "email" ? (
              <form
                method="post"
                action="#"
                onSubmit={onSendCode}
                className="mt-10 space-y-5"
              >
                <label className="block">
                  <span className="eyebrow">Registered email</span>
                  <input
                    required
                    type="email"
                    value={email}
                    disabled={pending}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-accent/50 disabled:opacity-60"
                    autoComplete="email"
                  />
                </label>
                {error ? (
                  <p className="text-sm text-danger" role="alert">
                    {error}
                    {/not found/i.test(error) ? (
                      <>
                        {" "}
                        <Link href="/signup" className="text-foreground hover:underline">
                          Create an account
                        </Link>
                      </>
                    ) : null}
                  </p>
                ) : null}
                <PendingButton
                  pending={pending}
                  pendingLabel="Sending code…"
                  className="bg-accent text-black"
                >
                  Send verification code
                </PendingButton>
                {pending ? (
                  <p className="text-center text-xs text-muted" aria-live="assertive">
                    Please wait…
                  </p>
                ) : null}
              </form>
            ) : null}

            {step === "code" ? (
              <form onSubmit={onVerifyCode} className="mt-10 space-y-5">
                {message ? (
                  <p className="text-sm text-muted">{message}</p>
                ) : null}
                {devCode ? (
                  <p className="rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-foreground">
                    Temporary OTP:{" "}
                    <span className="font-semibold tracking-[0.25em]">{devCode}</span>
                  </p>
                ) : null}
                <label className="block">
                  <span className="eyebrow">Verification code</span>
                  <input
                    required
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-4 py-3 text-sm tracking-[0.3em] outline-none focus:border-accent/50"
                    autoComplete="one-time-code"
                  />
                </label>
                {error ? (
                  <p className="text-sm text-danger" role="alert">
                    {error}
                  </p>
                ) : null}
                <PendingButton
                  pending={pending}
                  pendingLabel="Verifying…"
                  disabled={code.length !== 6}
                  className="bg-accent text-black"
                >
                  Verify code
                </PendingButton>
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setError(null);
                    setMessage(null);
                  }}
                  className="w-full text-sm text-muted hover:text-foreground"
                >
                  Use a different email
                </button>
              </form>
            ) : null}

            {step === "password" ? (
              <form onSubmit={onReset} className="mt-10 space-y-5">
                {message ? (
                  <p className="text-sm text-muted">{message}</p>
                ) : null}
                <label className="block">
                  <span className="eyebrow">New password</span>
                  <input
                    required
                    type="password"
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-accent/50"
                    autoComplete="new-password"
                  />
                </label>
                <label className="block">
                  <span className="eyebrow">Confirm password</span>
                  <input
                    required
                    type="password"
                    minLength={8}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-accent/50"
                    autoComplete="new-password"
                  />
                </label>
                {error ? (
                  <p className="text-sm text-danger" role="alert">
                    {error}
                  </p>
                ) : null}
                <PendingButton
                  pending={pending}
                  pendingLabel="Updating password…"
                  className="bg-foreground text-black"
                >
                  Update password
                </PendingButton>
              </form>
            ) : null}

            {step === "done" ? (
              <p className="mt-10 text-sm text-muted">
                {message || "Password updated."} Redirecting to log in…
              </p>
            ) : null}

            <p className="mt-8 text-sm text-muted">
              Remembered it?{" "}
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
