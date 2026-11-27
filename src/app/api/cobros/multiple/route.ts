import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { CobroError } from "@/lib/cobros/server/cobros-pg";
import { registrarCobroMultiple } from "@/lib/cobros/server/cobro-multiple-pg";
import { ReciboError } from "@/lib/recibos/server/recibos-pg";

/**
 * POST /api/cobros/multiple — cobra varias cuentas por cobrar de un cliente con un
 * solo pago y emite un único recibo con el detalle.
 * Body: { cuenta_ids: string[], monto?: number, metodo_pago, entidad_bancaria_id?, referencia?, ... }
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(errorResponse("JSON inválido."), { status: 400 });
    }

    const metodo = body.metodo_pago;
    const result = await registrarCobroMultiple(ctx.supabase, ctx.auth.empresa_id, {
      cuenta_ids: Array.isArray(body.cuenta_ids) ? body.cuenta_ids.map(String) : [],
      monto: body.monto == null || body.monto === "" ? null : Number(body.monto),
      metodo_pago: metodo === "transferencia" || metodo === "tarjeta" || metodo === "otro" ? metodo : "efectivo",
      entidad_bancaria_id: body.entidad_bancaria_id ? String(body.entidad_bancaria_id) : null,
      entidad_nombre_snapshot: body.entidad_nombre_snapshot ? String(body.entidad_nombre_snapshot) : null,
      referencia: body.referencia ? String(body.referencia) : null,
      titular: body.titular ? String(body.titular) : null,
      observaciones: body.observaciones ? String(body.observaciones) : null,
      usuario_id: ctx.auth.user?.id ?? null,
      usuario_nombre: ctx.auth.nombre ?? ctx.auth.user?.email ?? null,
    });
    return NextResponse.json(successResponse(result));
  } catch (err) {
    if (err instanceof CobroError || err instanceof ReciboError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    console.error("[/api/cobros/multiple POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo registrar el cobro."), { status: 500 });
  }
}
