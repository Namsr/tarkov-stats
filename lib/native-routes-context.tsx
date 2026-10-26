"use client";

import { createContext, useContext, type ReactNode } from "react";

const NativeRoutesContext = createContext({ arena: false, pve: false, regular: false });

/** Temporary boundary for pages migrated off Next. The server passes flags only. */
export function NativeRoutesProvider({ arena, pve = false, regular = false, children }: { arena: boolean; pve?: boolean; regular?: boolean; children: ReactNode }) {
  return <NativeRoutesContext.Provider value={{ arena, pve, regular }}>{children}</NativeRoutesContext.Provider>;
}

export function useNativeRoutes() {
  return useContext(NativeRoutesContext);
}
