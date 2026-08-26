import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * GET /api/reportes/historial-cliente?cliente_id=...&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 *
 * Todo lo que un cliente compró en un rango de fechas: el detalle venta por
 * venta y el resumen por producto (cuánto llevó de cada cosa y cuánto gastó).
 * Es el listado que se le muestra al cliente en obra.
 */
interface VentaRow {
  id: string;
  numero_control: string;
  fecha: string;
  total: number | string;
  tipo_venta: string | null;
  estado: string | null;
}
interface ItemRow {
  venta_id: string;
  producto_nombre: string;
  sku: string | null;
  cantidad: number | string;
  precio_venta: number | string;
  total_linea: number | string;
}
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;

    const sp = request.nextUrl.searchParams;
    const clienteId = (sp.get("cliente_id") ?? "").trim();
    const desde = (sp.get("desde") ?? "").trim();
    const hasta = (sp.get("hasta") ?? "").trim();
    if (!clienteId) return NextResponse.json(errorResponse("Elegí un cliente."), { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      return NextResponse.json(errorResponse("Indicá el rango de fechas (YYYY-MM-DD)."), { status: 400 });
    }

    // Datos del cliente (para el encabezado del listado impreso).
    const cliQ = await ctx.supabase
      .from("clientes")
      .select("id, empresa, nombre_contacto, nombre, ruc, documento, telefono, direccion")
      .eq("empresa_id", empresaId)
      .eq("id", clienteId)
      .maybeSingle();
    if (cliQ.error) throw new Error(cliQ.error.message);
    if (!cliQ.data) return NextResponse.json(errorResponse("Cliente no encontrado."), { status: 404 });
    const c = cliQ.data as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const cliente = {
      id: clienteId,
      nombre: s(c.empresa) || s(c.nombre_contacto) || s(c.nombre) || "Cliente",
      ruc: s(c.ruc) || s(c.documento),
      telefono: s(c.telefono),
      direccion: s(c.direccion),
    };

    // Ventas del cliente en el rango (se excluyen anuladas y devueltas).
    const ventasQ = await ctx.supabase
      .from("ventas")
      .select("id, numero_control, fecha, total, tipo_venta, estado")
      .eq("empresa_id", empresaId)
      .eq("cliente_id", clienteId)
      .gte("fecha", desde)
      .lte("fecha", `${hasta}T23:59:59.999Z`)
      .order("fecha", { ascending: true });
    if (ventasQ.error) throw new Error(ventasQ.error.message);
    const ventas = ((ventasQ.data ?? []) as VentaRow[]).filter(
      (v) => v.estado !== "anulada" && v.estado !== "devuelta_total"
    );

    if (ventas.length === 0) {
      return NextResponse.json(successResponse({
        cliente, periodo: { desde, hasta }, ventas: [], por_producto: [],
        totales: { ventas: 0, unidades: 0, total: 0 },
      }));
    }

    // Ítems por lotes: evita URLs enormes y el tope de 1000 filas de PostgREST.
    const ids = ventas.map((v) => v.id);
    const items: ItemRow[] = [];
    for (let i = 0; i < ids.length; i += 25) {
      const lote = ids.slice(i, i + 25);
      for (let desdeFila = 0; ; desdeFila += 1000) {
        const q = await ctx.supabase
          .from("ventas_items")
          .select("venta_id, producto_nombre, sku, cantidad, precio_venta, total_linea")
          .eq("empresa_id", empresaId)
          .in("venta_id", lote)
          .range(desdeFila, desdeFila + 999);
        if (q.error) throw new Error(q.error.message);
        const filas = (q.data ?? []) as ItemRow[];
        items.push(...filas);
        if (filas.length < 1000) break;
      }
    }

    const itemsPorVenta = new Map<string, ItemRow[]>();
    for (const it of items) {
      const lista = itemsPorVenta.get(it.venta_id) ?? [];
      lista.push(it);
      itemsPorVenta.set(it.venta_id, lista);
    }

    // Resumen por producto: cuánto llevó y cuánto gastó en cada cosa.
    const acum = new Map<string, { producto: string; sku: string | null; cantidad: number; total: number }>();
    for (const it of items) {
      const clave = `${it.producto_nombre}||${it.sku ?? ""}`;
      const a = acum.get(clave) ?? { producto: it.producto_nombre, sku: it.sku, cantidad: 0, total: 0 };
      a.cantidad += num(it.cantidad);
      a.total += num(it.total_linea);
      acum.set(clave, a);
    }
    const porProducto = [...acum.values()].sort((a, b) => b.total - a.total);

    return NextResponse.json(successResponse({
      cliente,
      periodo: { desde, hasta },
      ventas: ventas.map((v) => ({
        id: v.id,
        numero_control: v.numero_control,
        fecha: v.fecha,
        tipo_venta: v.tipo_venta,
        total: Math.round(num(v.total)),
        items: (itemsPorVenta.get(v.id) ?? []).map((it) => ({
          producto: it.producto_nombre,
          sku: it.sku,
          cantidad: num(it.cantidad),
          precio: Math.round(num(it.precio_venta)),
          total: Math.round(num(it.total_linea)),
        })),
      })),
      por_producto: porProducto.map((p) => ({ ...p, total: Math.round(p.total) })),
      totales: {
        ventas: ventas.length,
        unidades: porProducto.reduce((s2, p) => s2 + p.cantidad, 0),
        total: ventas.reduce((s2, v) => s2 + num(v.total), 0),
      },
    }));
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err);
    console.error("[/api/reportes/historial-cliente]", detalle);
    return NextResponse.json(errorResponse(`No se pudo cargar el historial: ${detalle}`), { status: 500 });
  }
}
