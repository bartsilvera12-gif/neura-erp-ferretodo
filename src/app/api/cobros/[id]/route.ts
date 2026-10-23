import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { isAdmin } from "@/lib/middleware/auth";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { corregirCobro, CobroError } from "@/lib/cobros/server/cobros-pg";

/**
 * PATCH /api/cobros/[id] — corrige un cobro mal registrado (solo admin).
 *
 * Anula el cobro original y registra uno nuevo con el monto/método/fecha
 * correctos sobre la misma cuenta por cobrar, dejando el saldo pendiente al
 * día. El monto original de la factura (total de la cuenta) NO se altera y el
 * cobro anulado se conserva en el historial.
 *
 * Body: { monto, metodo_pago?, entidad_bancaria_id?, entidad_nombre_snapshot?,
 *         referencia?, titular?, observaciones?, fecha_pago?, motivo? }
 */
export async function PATCH(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    if (!isAdmin(ctx.auth)) {
      return NextResponse.json(errorResponse("Solo un administrador puede corregir un cobro."), { status: 403 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }

    const result = await corregirCobro(ctx.supabase, ctx.auth.empresa_id, {
      cobro_id: id,
      monto: Number(body.monto),
      metodo_pago: (body.metodo_pago as "efectivo" | "transferencia" | "tarjeta" | "otro") ?? "efectivo",
      entidad_bancaria_id: body.entidad_bancaria_id ? String(body.entidad_bancaria_id) : null,
      entidad_nombre_snapshot: body.entidad_nombre_snapshot ? String(body.entidad_nombre_snapshot) : null,
      referencia: body.referencia ? String(body.referencia) : null,
      titular: body.titular ? String(body.titular) : null,
      observaciones: body.observaciones ? String(body.observaciones) : null,
      fecha_pago: typeof body.fecha_pago === "string" ? body.fecha_pago : null,
      motivo: body.motivo == null ? null : String(body.motivo),
      usuario_id: ctx.auth.user?.id ?? null,
      usuario_nombre: ctx.auth.nombre ?? ctx.auth.user?.email ?? null,
    });

    return NextResponse.json(successResponse(result));
  } catch (err) {
    if (err instanceof CobroError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    console.error("[/api/cobros/[id] PATCH]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo corregir el cobro."), { status: 500 });
  }
}
