"use client";

import { createContext, useContext, type ReactNode } from "react";

const NativeRoutesContext = createContext({ arena: false, pve: false, regular: false, seasonal: false });

/** Temporary boundary for pages migrated off Next. The server passes flags only. */
export function NativeRoutesProvider({ arena, pve = false, regular = false, seasonal = false, children }: { arena: boolean; pve?: boolean; regular?: boolean; seasonal?: boolean; children: ReactNode }) {
  return <NativeRoutesContext.Provider value={{ arena, pve, regular, seasonal }}>{children}</NativeRoutesContext.Provider>;
}

export function useNativeRoutes() {
  return useContext(NativeRoutesContext);
}
