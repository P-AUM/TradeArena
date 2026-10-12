"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import TraderDashboard from "@/components/TraderDashboard";
import ViewerDashboard from "@/components/ViewerDashboard";
import { useAuth } from "@/lib/auth";

export default function DashboardPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  return (
    <>
      <Navbar />
      <main className="relative flex-1 overflow-hidden">
        <div className="hero-atmosphere absolute inset-0" />
        <div className="relative">
          {loading || !user ? (
            <div className="mx-auto max-w-7xl px-6 pt-40 pb-24">
              <p className="thin text-muted">Loading desk…</p>
            </div>
          ) : user.role === "trader" ? (
            <TraderDashboard user={user} />
          ) : (
            <ViewerDashboard user={user} />
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
