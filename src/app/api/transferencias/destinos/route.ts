import { NextRequest, NextResponse } from "next/server";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { contextoTransferencias } from "../_auth";
import { listarDestinosPosibles, TransferenciaError } from "@/lib/transferencias/server/transferencias-pg";

/** GET /api/transferencias/destinos — empresas del grupo a las que se puede enviar. */
export async function GET(request: NextRequest) {
  try {
    const ctx = await contextoTransferencias(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    return NextResponse.json(successResponse({ destinos: await listarDestinosPosibles(ctx.empresaId) }));
  } catch (err) {
    if (err instanceof TransferenciaError) {
      return NextResponse.json(errorResponse(err.message), { status: err.status });
    }
    const d = err instanceof Error ? err.message : String(err);
    console.error("[/api/transferencias/destinos GET]", d);
    return NextResponse.json(errorResponse(`No se pudieron cargar las empresas: ${d}`), { status: 500 });
  }
}
