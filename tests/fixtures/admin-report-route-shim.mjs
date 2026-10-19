export async function requireAdmin() {
  const status = Number(process.env.ADMIN_REPORT_TEST_AUTH ?? 401);
  return status === 200 ? { ok: true, user: { sub: "fixture-admin" } } : { ok: false, status };
}
export async function getSuspiciousSummary() { return { new: 0, severe: 0 }; }
export async function fetchCloudflareTrafficRange(from, to) {
  return { visits: 0, pageviews: 0, available: false, sampled: false, from, to, series: [] };
}
