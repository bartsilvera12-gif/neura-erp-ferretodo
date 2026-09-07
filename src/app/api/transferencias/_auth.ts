import { NextRequest } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";

/** Contexto minimo que necesitan las rutas de transferencias. */
export async function contextoTransferencias(request: NextRequest) {
  const ctx = await getTenantSupabaseFromAuth(request);
  if (!ctx) return null;
  return {
    empresaId: ctx.auth.empresa_id,
    usuarioId: ctx.auth.usuarioCatalogId ?? null,
    usuarioNombre: (ctx.auth.nombre ?? ctx.auth.user?.email ?? "").trim() || null,
  };
}
