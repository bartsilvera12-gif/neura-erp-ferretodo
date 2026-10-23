import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { isAdmin } from "@/lib/middleware/auth";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { anularCobro, CobroError } from "@/lib/cobros/server/cobros-pg";

/**
 * POST /api/cobros/[id]/anular — anula un cobro mal registrado (solo admin).
 *
 * Anulación SOFT: el cobro queda en la tabla con anulado_at + auditoría y deja
 * de contar. El saldo de la cuenta por cobrar se recalcula desde los cobros
 * vigentes (el total/monto original de la factura NO se toca) y el ingreso en
 * caja se revierte. Idempotente.
 *
 * Body: { motivo?: string }
 */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    if (!isAdmin(ctx.auth)) {
      return NextResponse.json(errorResponse("Solo un administrador puede anular un cobro."), { status: 403 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const result = await anularCobro(ctx.supabase, ctx.auth.empresa_id, {
      cobro_id: id,
      motivo: body.motivo == null ? null : String(body.motivo),
      usuario_id: ctx.auth.user?.id ?? null,
      usuario_nombre: ctx.auth.nombre ?? ctx.auth.user?.email ?? null,
    });

    return NextResponse.json(successResponse(result));
  } catch (err) {
    if (err instanceof CobroError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    console.error("[/api/cobros/[id]/anular POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo anular el cobro."), { status: 500 });
  }
}
