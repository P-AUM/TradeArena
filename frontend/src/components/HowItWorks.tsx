const STEPS = [
  {
    n: "01",
    title: "Pick your role",
    body: "Sign up as a Trader or a Viewer. Roles are locked — traders compete, viewers follow.",
  },
  {
    n: "02",
    title: "Trade on paper",
    body: "Simulate crypto and forex with separate virtual wallets. No real money at risk.",
  },
  {
    n: "03",
    title: "Get seen",
    body: "Every trade is public. Followers watch your book. Climb PnL, ROI, and win-rate boards.",
  },
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="border-t border-border">
      <div className="mx-auto max-w-7xl px-6 py-24 md:py-32">
        <p className="eyebrow">How it works</p>
        <h2 className="statement mt-5 max-w-3xl text-5xl uppercase sm:text-6xl md:text-7xl">
          Three moves.
          <br />
          One arena.
        </h2>

        <ol className="mt-16 grid gap-12 md:grid-cols-3 md:gap-10">
          {STEPS.map((step) => (
            <li key={step.n} className="border-t border-border pt-8">
              <span className="eyebrow text-accent">{step.n}</span>
              <h3
                className="mt-4 text-2xl uppercase tracking-tight"
                style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
              >
                {step.title}
              </h3>
              <p className="thin mt-4 text-base text-muted leading-relaxed">
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
