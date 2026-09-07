import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { contextoTransferencias } from "../_auth";
import { getTransferencia, sugerirProductosDestino, TransferenciaError } from "@/lib/transferencias/server/transferencias-pg";

/**
 * GET /api/transferencias/[id] — cabecera + items.
 * Si la empresa es la receptora, se agregan las sugerencias de emparejamiento
 * por codigo para que el funcionario no tenga que buscar cada producto a mano
 * (la asignacion final igual la confirma el).
 */
export async function GET(request: NextRequest, ctxParams: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctxParams.params;
    const ctx = await contextoTransferencias(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });

    const transferencia = await getTransferencia(id, ctx.empresaId);
    if (!transferencia) return NextResponse.json(errorResponse(API_ERRORS.NOT_FOUND), { status: 404 });

    let sugerencias: Record<string, unknown> = {};
    if (transferencia.rol === "destino" && transferencia.estado === "pendiente") {
      try {
        sugerencias = await sugerirProductosDestino(id, ctx.empresaId);
      } catch (e) {
        // Best-effort: sin sugerencias igual se puede recibir eligiendo a mano.
        console.error("[/api/transferencias/[id]] sugerencias:", e instanceof Error ? e.message : e);
      }
    }
    return NextResponse.json(successResponse({ transferencia, sugerencias }));
  } catch (err) {
    if (err instanceof TransferenciaError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    const d = err instanceof Error ? err.message : String(err);
    console.error("[/api/transferencias/[id] GET]", d);
    return NextResponse.json(errorResponse(`No se pudo cargar la transferencia: ${d}`), { status: 500 });
  }
}
