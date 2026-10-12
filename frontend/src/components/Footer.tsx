import Link from "next/link";
import Logo from "./Logo";

export default function Footer() {
  return (
    <footer className="border-t border-border mt-24">
      <div className="mx-auto max-w-7xl px-6 py-12 flex flex-col md:flex-row items-center justify-between gap-6">
        <Logo />
        <p className="text-sm text-muted text-center">
          Paper trade crypto &amp; forex. Climb in public.
        </p>
        <div className="flex items-center gap-6 text-sm text-muted">
          <Link href="#how-it-works" className="hover:text-foreground transition-colors">
            How it works
          </Link>
          <Link href="#features" className="hover:text-foreground transition-colors">
            Features
          </Link>
          <Link href="/signup" className="hover:text-foreground transition-colors">
            Sign up
          </Link>
        </div>
      </div>
      <div className="border-t border-border">
        <p className="mx-auto max-w-7xl px-6 py-5 text-xs text-muted">
          © {new Date().getFullYear()} TradeArena · Temporary name · Paper trading only
        </p>
      </div>
    </footer>
  );
}
