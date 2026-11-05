"use client";

import { useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

/** Hook simple: devuelve true si el usuario actual tiene rol admin. */
export function useIsAdmin(): { isAdmin: boolean; loaded: boolean } {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancel = false;
    // IMPORTANTE: usar fetchWithSupabaseSession (adjunta el JWT de la sesión en
    // localStorage como Bearer). Con `fetch` plano + credentials:"include" el
    // endpoint respondía 401 cuando la sesión no vive en cookie (que es el caso
    // general de esta app), por lo que isAdmin quedaba SIEMPRE en false y los
    // paneles solo-admin (p. ej. aprobación de solicitudes de stock) nunca se
    // mostraban al administrador.
    fetchWithSupabaseSession("/api/me/rol", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancel) return;
        setIsAdmin(j?.success && j.data?.isAdmin === true);
        setLoaded(true);
      })
      .catch(() => { if (!cancel) setLoaded(true); });
    return () => { cancel = true; };
  }, []);
  return { isAdmin, loaded };
}
