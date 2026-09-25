import { Suspense } from "react";
import ComparePage from "@/components/ComparePage";

export default function CompareRoutePage() {
  return (
    <Suspense fallback={<main className="page-frame" aria-busy="true" />}>
      <ComparePage />
    </Suspense>
  );
}
