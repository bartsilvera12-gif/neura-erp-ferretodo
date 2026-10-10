import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { isAdmin } from "@/lib/middleware/auth";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/ventas/[id]/vendedor
 *
 * Reasigna el vendedor (usuario que registró la venta) de una venta existente.
 * Corrección de Admin: por ejemplo, una venta se cargó con el código de un
 * usuario pero correspondía a otro. Solo cambia la metadata de auditoría de la
 * venta (created_by / usuario_nombre); NO toca stock, caja ni factura.
 *
 * Solo administradores. El usuario destino debe pertenecer a la misma empresa y
 * estar activo. Queda registro en vendedor_reasignado_at / vendedor_reasignado_por.
 *
 * Body: { usuario_id: string (uuid) }
 */
export async function PATCH(
  request: NextRequest,
  ctxParams: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    if (!isAdmin(ctx.auth)) {
      return NextResponse.json(
        errorResponse("Solo un administrador puede cambiar el vendedor de una venta."),
        { status: 403 }
      );
    }

    const { id: ventaId } = await ctxParams.params;
    if (!ventaId || !uuidRe.test(ventaId)) {
      return NextResponse.json(errorResponse("Venta inválida."), { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as { usuario_id?: unknown };
    const usuarioId = typeof body.usuario_id === "string" ? body.usuario_id.trim() : "";
    if (!usuarioId || !uuidRe.test(usuarioId)) {
      return NextResponse.json(errorResponse("Seleccioná un usuario válido."), { status: 400 });
    }

    const { supabase, auth } = ctx;
    const empresaId = auth.empresa_id;

    // 1) La venta existe y es de esta empresa.
    const { data: venta, error: eV } = await supabase
      .from("ventas")
      .select("id, numero_control, usuario_nombre")
      .eq("id", ventaId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (eV) throw new Error(eV.message);
    if (!venta) {
      return NextResponse.json(errorResponse("Venta no encontrada."), { status: 404 });
    }

    // 2) El usuario destino pertenece a esta empresa y está activo.
    const { data: usuario, error: eU } = await supabase
      .from("usuarios")
      .select("id, nombre, email, estado")
      .eq("id", usuarioId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (eU) throw new Error(eU.message);
    if (!usuario) {
      return NextResponse.json(
        errorResponse("El usuario seleccionado no pertenece a esta empresa."),
        { status: 400 }
      );
    }
    if (usuario.estado && usuario.estado !== "activo") {
      return NextResponse.json(
        errorResponse("El usuario seleccionado está inactivo."),
        { status: 400 }
      );
    }

    const nombreDestino =
      (typeof usuario.nombre === "string" && usuario.nombre.trim()) ||
      (typeof usuario.email === "string" && usuario.email.trim()) ||
      null;

    // 3) Reasignar. Solo metadata de auditoría de la venta.
    const { error: eUp } = await supabase
      .from("ventas")
      .update({
        created_by: usuarioId,
        usuario_nombre: nombreDestino,
        vendedor_reasignado_at: new Date().toISOString(),
        vendedor_reasignado_por: auth.nombre ?? auth.user?.email ?? null,
      })
      .eq("id", ventaId)
      .eq("empresa_id", empresaId);
    if (eUp) throw new Error(eUp.message);

    return NextResponse.json(
      successResponse({
        ok: true,
        venta_id: ventaId,
        usuario_id: usuarioId,
        usuario_nombre: nombreDestino,
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo cambiar el vendedor.";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
