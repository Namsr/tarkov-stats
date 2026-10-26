"use client";

import { createContext, useContext, type ReactNode } from "react";

const NativeRoutesContext = createContext({ arena: false });

/** Temporary boundary for pages migrated off Next. The server passes flags only. */
export function NativeRoutesProvider({ arena, children }: { arena: boolean; children: ReactNode }) {
  return <NativeRoutesContext.Provider value={{ arena }}>{children}</NativeRoutesContext.Provider>;
}

export function useNativeRoutes() {
  return useContext(NativeRoutesContext);
}
