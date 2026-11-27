import { notFound } from "next/navigation";

// The AXIS League section is hidden from the public site. Keep the route
// explicit so old links resolve to the site 404 instead of a stale page.
export default async function AxisLeagueRoute() {
  notFound();
}
