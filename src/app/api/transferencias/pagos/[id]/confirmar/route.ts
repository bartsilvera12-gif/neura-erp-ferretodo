import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { contextoTransferencias } from "../../../_auth";
import { confirmarPagoInterno } from "@/lib/transferencias/server/cuenta-corriente-pg";
import { TransferenciaError } from "@/lib/transferencias/server/transferencias-pg";

/** POST — la empresa que cobra acusa recibo; ahí entra a su caja. */
export async function POST(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await contextoTransferencias(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const res = await confirmarPagoInterno({
      pagoId: id,
      empresaCobraId: ctx.empresaId,
      usuarioId: ctx.usuarioId,
      usuarioNombre: ctx.usuarioNombre,
    });
    return NextResponse.json(successResponse(res));
  } catch (err) {
    if (err instanceof TransferenciaError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    const d = err instanceof Error ? err.message : String(err);
    console.error("[/api/transferencias/pagos/[id]/confirmar]", d);
    return NextResponse.json(errorResponse(`No se pudo confirmar el pago: ${d}`), { status: 500 });
  }
}
