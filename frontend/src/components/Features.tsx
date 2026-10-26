const FEATURES = [
  {
    title: "Public paper books",
    body: "Traders open and close simulated positions. Viewers see the same tape in real time.",
  },
  {
    title: "Multi-board ranks",
    body: "Switch between PnL, ROI, and win rate — daily, weekly, monthly, all-time, or custom range.",
  },
  {
    title: "Crypto + forex wallets",
    body: "Separate virtual balances per market. Same fixed starting capital for a fair fight.",
  },
  {
    title: "Social by default",
    body: "Follow traders, scroll a live feed, comment on moves, get notified on opens and closes.",
  },
];

export default function Features() {
  return (
    <section id="features" className="border-t border-border">
      <div className="mx-auto max-w-7xl px-6 py-28 md:py-40">
        <p className="eyebrow">Features</p>
        <h2 className="statement mt-8 max-w-4xl break-words text-4xl uppercase leading-[1.1] sm:text-6xl md:mt-10 md:text-7xl md:leading-[1.1]">
          Built for
          <br />
          <span className="accent-text">spectators</span>
          <br />
          and killers.
        </h2>
        <p className="thin mt-10 max-w-xl text-lg text-muted md:mt-12">
          A dark terminal for people who trade — and for people who watch.
        </p>

        <ul className="mt-20 divide-y divide-border border-y border-border">
          {FEATURES.map((f) => (
            <li
              key={f.title}
              className="grid gap-4 py-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-16"
            >
              <h3
                className="text-2xl uppercase tracking-tight md:text-3xl"
                style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
              >
                {f.title}
              </h3>
              <p className="thin self-center text-base text-muted leading-relaxed md:text-lg">
                {f.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
