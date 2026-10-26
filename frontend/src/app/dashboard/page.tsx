"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import AdminDashboard from "@/components/AdminDashboard";
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
      <main className="relative min-w-0 flex-1">
        <div
          className="hero-atmosphere pointer-events-none absolute inset-0 overflow-hidden"
          aria-hidden
        />
        <div className="relative">
          {loading || !user ? (
            <div className="mx-auto max-w-7xl px-6 pt-40 pb-24">
              <p className="thin text-muted">Loading desk…</p>
            </div>
          ) : user.role === "trader" ? (
            <TraderDashboard user={user} />
          ) : user.role === "admin" ? (
            <AdminDashboard user={user} />
          ) : (
            <ViewerDashboard user={user} />
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
