import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * PUT /api/comisiones/ferretodo/override
 *
 * Define, para un VENDEDOR y un MES, cómo se calcula su comisión y en qué
 * estado de pago está. Sin override, el cálculo usa 5% sobre la ganancia y
 * estado "retenida".
 *
 * Body: { vendedor, periodo: "YYYY-MM", tipo: "porcentaje"|"monto_fijo",
 *         valor: number, estado: "retenida"|"liberada"|"pagada", observacion? }
 */
const TIPOS = ["porcentaje", "monto_fijo"] as const;
const ESTADOS = ["retenida", "liberada", "pagada"] as const;

export async function PUT(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;

    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const vendedor = typeof b.vendedor === "string" ? b.vendedor.trim() : "";
    const periodo = typeof b.periodo === "string" ? b.periodo.trim() : "";
    if (!vendedor) return NextResponse.json(errorResponse("Falta el vendedor."), { status: 400 });
    if (!/^\d{4}-\d{2}$/.test(periodo)) {
      return NextResponse.json(errorResponse("El período debe tener formato YYYY-MM."), { status: 400 });
    }

    const tipoRaw = typeof b.tipo === "string" ? b.tipo : "porcentaje";
    const tipo = (TIPOS as readonly string[]).includes(tipoRaw) ? tipoRaw : "porcentaje";
    const estadoRaw = typeof b.estado === "string" ? b.estado : "retenida";
    const estado = (ESTADOS as readonly string[]).includes(estadoRaw) ? estadoRaw : "retenida";

    const valor = Number(b.valor);
    if (!Number.isFinite(valor) || valor < 0) {
      return NextResponse.json(errorResponse("El valor debe ser un número mayor o igual a 0."), { status: 400 });
    }
    if (tipo === "porcentaje" && valor > 100) {
      return NextResponse.json(errorResponse("El porcentaje no puede ser mayor a 100."), { status: 400 });
    }

    const observacion =
      typeof b.observacion === "string" && b.observacion.trim() ? b.observacion.trim().slice(0, 500) : null;

    const { data, error } = await ctx.supabase
      .from("comision_periodo_vendedor")
      .upsert(
        { empresa_id: empresaId, vendedor, periodo, tipo, valor, estado, observacion, updated_at: new Date().toISOString() },
        { onConflict: "empresa_id,vendedor,periodo" }
      )
      .select()
      .single();

    if (error) return NextResponse.json(errorResponse(error.message), { status: 400 });
    return NextResponse.json(successResponse({ override: data }));
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err);
    console.error("[/api/comisiones/ferretodo/override PUT]", detalle);
    return NextResponse.json(errorResponse(`No se pudo guardar la comisión: ${detalle}`), { status: 500 });
  }
}
