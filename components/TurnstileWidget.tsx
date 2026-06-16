"use client";

import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { useState, useRef, useCallback } from "react";

const SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "0x4AAAAAAAVVIHGZCr2PPwrR";

interface TurnstileWidgetProps {
  onToken: (token: string) => void;
}

export default function TurnstileWidget({ onToken }: TurnstileWidgetProps) {
  const [error, setError] = useState("");
  const [verified, setVerified] = useState(false);
  const widgetRef = useRef<TurnstileInstance | undefined>(undefined);

  const handleSuccess = useCallback((token: string) => {
    setError("");
    setVerified(true);
    onToken(token);
  }, [onToken]);

  const handleError = useCallback((code: string) => {
    setError(`Verification failed (${code}). Click retry or refresh the page.`);
  }, []);

  const handleExpire = useCallback(() => {
    setVerified(false);
    setError("Verification expired. Click retry to re-verify.");
  }, []);

  const handleRetry = useCallback(() => {
    setError("");
    widgetRef.current?.reset();
  }, []);

  if (verified) return null;

  return (
    <div className="flex flex-col items-center gap-2">
      <Turnstile
        ref={widgetRef}
        siteKey={SITE_KEY}
        onSuccess={handleSuccess}
        onError={handleError}
        onExpire={handleExpire}
        options={{
          theme: "dark",
          appearance: "always",
          size: "normal",
          retry: "auto",
          retryInterval: 5000,
        }}
      />
      {error && (
        <div className="flex flex-col items-center gap-1">
          <p className="text-xs text-[var(--danger)]">{error}</p>
          <button
            onClick={handleRetry}
            className="text-xs text-[var(--accent)] hover:underline"
          >
            Retry verification
          </button>
        </div>
      )}
    </div>
  );
}
