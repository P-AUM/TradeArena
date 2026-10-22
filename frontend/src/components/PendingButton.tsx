"use client";

import type { ButtonHTMLAttributes } from "react";

type PendingButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  pending: boolean;
  pendingLabel: string;
};

export default function PendingButton({
  pending,
  pendingLabel,
  children,
  className = "",
  disabled,
  type = "submit",
  ...props
}: PendingButtonProps) {
  return (
    <button
      type={type}
      disabled={pending || disabled}
      aria-busy={pending}
      className={`inline-flex w-full items-center justify-center gap-2.5 rounded-full px-6 py-3.5 text-sm font-semibold ${
        pending
          ? "cursor-wait ring-2 ring-foreground/50 brightness-90"
          : "transition-opacity hover:opacity-90"
      } ${className}`}
      style={{ fontFamily: "var(--font-display)" }}
      {...props}
    >
      {pending ? (
        <>
          <span className="btn-spinner btn-spinner-lg" aria-hidden="true" />
          <span>{pendingLabel}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
