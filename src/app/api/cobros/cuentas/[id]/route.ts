import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * PATCH /api/cobros/cuentas/[id] — actualiza datos editables de una cuenta por
 * cobrar. Por ahora: fecha_vencimiento de un crédito.
 * Body: { fecha_vencimiento: "YYYY-MM-DD" | null }
 */
export async function PATCH(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }

    const raw = body.fecha_vencimiento;
    let fechaVencimiento: string | null = null;
    if (raw != null && String(raw).trim() !== "") {
      const v = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        return NextResponse.json(errorResponse("Fecha de vencimiento inválida (usá AAAA-MM-DD)."), { status: 400 });
      }
      fechaVencimiento = v;
    }

    // No se permite cambiar el vencimiento de una cuenta anulada.
    const cq = await ctx.supabase
      .from("cuentas_por_cobrar")
      .select("id, estado")
      .eq("empresa_id", empresaId)
      .eq("id", id)
      .maybeSingle();
    if (cq.error) throw new Error(cq.error.message);
    if (!cq.data) return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });
    if ((cq.data as { estado?: string }).estado === "anulado") {
      return NextResponse.json(errorResponse("La cuenta está anulada; no se puede editar."), { status: 409 });
    }

    const upd = await ctx.supabase
      .from("cuentas_por_cobrar")
      .update({ fecha_vencimiento: fechaVencimiento, updated_at: new Date().toISOString() })
      .eq("empresa_id", empresaId)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (upd.error) throw new Error(upd.error.message);
    if (!upd.data) return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });

    return NextResponse.json(successResponse({ id, fecha_vencimiento: fechaVencimiento }));
  } catch (err) {
    console.error("[/api/cobros/cuentas/[id] PATCH]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo actualizar la cuenta."), { status: 500 });
  }
}
