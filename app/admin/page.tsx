import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AdminDashboard from "@/components/AdminDashboard";
import { getAdminSession } from "@/lib/admin-auth";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  if (!(await getAdminSession())) notFound();
  return <AdminDashboard />;
}
