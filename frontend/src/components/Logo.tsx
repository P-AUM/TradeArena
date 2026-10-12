export default function Logo({ wordmark = "TradeArena" }: { wordmark?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <span
        className="grid h-7 w-7 shrink-0 place-items-center rounded-sm border border-border bg-white/[0.04]"
        aria-hidden="true"
      >
        <span className="h-2.5 w-2.5 rotate-45 bg-accent" />
      </span>
      <span className="font-[family-name:var(--font-display)] text-lg font-bold tracking-tight">
        {wordmark}
      </span>
    </span>
  );
}
