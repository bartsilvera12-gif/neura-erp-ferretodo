import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * GET /api/comisiones/ferretodo?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 *
 * Calcula comisiones sobre GANANCIA por vendedor. La ganancia se calcula
 * como precio_venta - costo_unitario a nivel item, usando el costo snapshot
 * guardado en movimientos_inventario al momento de la SALIDA.
 *
 * Regla de cobro de la comisión:
 *   - Ventas CONTADO: cuentan en el mes de la venta (se cobran al instante).
 *   - Ventas CRÉDITO: NO cuentan hasta que el cliente SALDA toda la deuda.
 *     Cuando la cuenta_por_cobrar queda 'pagado', la comisión cuenta en el mes
 *     en que se terminó de pagar (fecha del último cobro), no en el de la venta.
 *     Un crédito pendiente o pagado a medias NO suma comisión.
 *
 * Ferretodo: porcentaje único sobre la ganancia (sin tramos), con override
 * manual por vendedor/mes.
 */

/** Ferretodo: porcentaje unico sobre la ganancia (sin tramos). */
const PORCENTAJE_COMISION = 5;

const ESCALAS = [
  { desde: 0, hasta: null, porcentaje: PORCENTAJE_COMISION },
];

type VentaRow = {
  id: string;
  numero_control?: string | null;
  total: number | string | null;
  fecha: string | null;
  estado?: string | null;
  usuario_nombre?: string | null;
  created_by?: string | null;
  tipo_venta?: string | null;
};

const CHUNK = 80;

export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;
    const sb = ctx.supabase;

    const sp = request.nextUrl.searchParams;
    const desde = sp.get("desde") || "";
    const hasta = sp.get("hasta") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      return NextResponse.json(errorResponse("Faltan desde/hasta (YYYY-MM-DD)."), { status: 400 });
    }
    const hastaTs = `${hasta}T23:59:59.999Z`;
    const tDesde = new Date(`${desde}T00:00:00.000Z`).getTime();
    const tHasta = new Date(hastaTs).getTime();

    const activa = (v: VentaRow) => v.estado !== "anulada" && v.estado !== "devuelta_total";
    const SELECT_VENTA =
      "id, numero_control, total, fecha, estado, usuario_nombre, created_by, tipo_venta";

    // =========================================================================
    // 1) Ventas CONTADO del período (por fecha de venta) — cuentan al instante.
    // =========================================================================
    // Se traen todas las del período y se separan en código: así una venta sin
    // tipo marcado (null, datos viejos) cuenta como contado y no se pierde.
    const { data: periodoRaw, error: eC } = await sb
      .from("ventas")
      .select(SELECT_VENTA)
      .eq("empresa_id", empresaId)
      .gte("fecha", desde)
      .lte("fecha", hastaTs);
    if (eC) throw new Error(eC.message);
    const contadoVentas = ((periodoRaw ?? []) as VentaRow[]).filter(
      (v) => activa(v) && (v.tipo_venta ?? "") !== "CREDITO"
    );

    // =========================================================================
    // 2) Ventas CRÉDITO cuya deuda se SALDÓ dentro del período (por fecha de
    //    cobro = último abono). La comisión cuenta recién al terminar de cobrar.
    // =========================================================================
    // 2a) Cuentas por cobrar ya pagadas por completo.
    const { data: cxcPagadasRaw, error: eX } = await sb
      .from("cuentas_por_cobrar")
      .select("id, venta_id, estado, saldo")
      .eq("empresa_id", empresaId)
      .eq("estado", "pagado");
    if (eX) throw new Error(eX.message);
    const cxcPagadas = (cxcPagadasRaw ?? []) as Array<{ id: string; venta_id: string }>;

    // 2b) Fecha en que se saldó cada cuenta = MAX(cobros_clientes.fecha_pago).
    const cuentaIds = cxcPagadas.map((c) => String(c.id));
    const maxPagoByCuenta = new Map<string, number>();
    for (let i = 0; i < cuentaIds.length; i += CHUNK) {
      const chunk = cuentaIds.slice(i, i + CHUNK);
      const { data: cobros, error: eCob } = await sb
        .from("cobros_clientes")
        .select("cuenta_por_cobrar_id, fecha_pago")
        .eq("empresa_id", empresaId)
        .in("cuenta_por_cobrar_id", chunk);
      if (eCob) throw new Error(eCob.message);
      for (const row of (cobros ?? []) as Array<{ cuenta_por_cobrar_id: string; fecha_pago: string | null }>) {
        const cid = String(row.cuenta_por_cobrar_id);
        const t = row.fecha_pago ? new Date(row.fecha_pago).getTime() : NaN;
        if (!Number.isFinite(t)) continue;
        const prev = maxPagoByCuenta.get(cid);
        if (prev === undefined || t > prev) maxPagoByCuenta.set(cid, t);
      }
    }

    // 2c) Cuentas saldadas dentro del período → venta_id + fecha de cobro.
    const fechaCobroPorVenta = new Map<string, string>();
    for (const c of cxcPagadas) {
      const t = maxPagoByCuenta.get(String(c.id));
      if (t === undefined || t < tDesde || t > tHasta) continue;
      fechaCobroPorVenta.set(String(c.venta_id), new Date(t).toISOString());
    }

    // 2d) Traer esas ventas (crédito, activas).
    const creditIds = [...fechaCobroPorVenta.keys()];
    const creditVentas: VentaRow[] = [];
    for (let i = 0; i < creditIds.length; i += CHUNK) {
      const chunk = creditIds.slice(i, i + CHUNK);
      const { data, error: eCV } = await sb
        .from("ventas")
        .select(SELECT_VENTA)
        .eq("empresa_id", empresaId)
        .in("id", chunk);
      if (eCV) throw new Error(eCV.message);
      for (const v of (data ?? []) as VentaRow[]) {
        if (activa(v) && (v.tipo_venta ?? "") === "CREDITO") creditVentas.push(v);
      }
    }

    // =========================================================================
    // 3) Costo snapshot (movimientos SALIDA) de TODAS las ventas incluidas.
    // =========================================================================
    const ventas = [...contadoVentas, ...creditVentas];
    const ventaIds = ventas.map((v) => String(v.id));
    if (ventaIds.length === 0) {
      return NextResponse.json(successResponse({
        periodo: { desde, hasta, mes: desde.slice(0, 7) },
        escalas: ESCALAS,
        por_vendedor: [],
        totales: { ventas: 0, ingresos: 0, costo: 0, ganancia: 0, comision: 0, comision_liberada: 0 },
      }));
    }

    const movs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < ventaIds.length; i += CHUNK) {
      const chunk = ventaIds.slice(i, i + CHUNK);
      const { data, error: eM } = await sb
        .from("movimientos_inventario")
        .select("venta_id, cantidad, costo_unitario, tipo, anulado_at")
        .eq("empresa_id", empresaId)
        .eq("tipo", "SALIDA")
        .in("venta_id", chunk);
      if (eM) throw new Error(eM.message);
      if (data) movs.push(...(data as Array<Record<string, unknown>>));
    }

    const costoPorVenta = new Map<string, number>();
    for (const m of movs) {
      if (m.anulado_at) continue;
      const vid = String(m.venta_id ?? "");
      if (!vid) continue;
      const c = (Number(m.cantidad) || 0) * (Number(m.costo_unitario) || 0);
      costoPorVenta.set(vid, (costoPorVenta.get(vid) ?? 0) + c);
    }

    // =========================================================================
    // 4) Agrupar por vendedor + detalle venta por venta.
    // =========================================================================
    type DetVenta = {
      venta_id: string; numero: string; fecha: string | null;
      tipo: "CONTADO" | "CREDITO"; fecha_cobro: string | null;
      vendido: number; costo: number; ganancia: number;
    };
    type Agg = { vendedor: string; ventas: number; ingresos: number; costo: number; ganancia: number; detalle: DetVenta[] };
    const porVendedor = new Map<string, Agg>();
    for (const v of ventas) {
      const nombre = (v.usuario_nombre?.trim() as string) || "Sin vendedor";
      const ingresos = Number(v.total) || 0;
      const costo = costoPorVenta.get(String(v.id)) ?? 0;
      const ganancia = ingresos - costo;
      const esCredito = (v.tipo_venta ?? "") === "CREDITO";
      let a = porVendedor.get(nombre);
      if (!a) { a = { vendedor: nombre, ventas: 0, ingresos: 0, costo: 0, ganancia: 0, detalle: [] }; porVendedor.set(nombre, a); }
      a.ventas += 1;
      a.ingresos += ingresos;
      a.costo += costo;
      a.ganancia += ganancia;
      a.detalle.push({
        venta_id: String(v.id),
        numero: String(v.numero_control ?? ""),
        fecha: v.fecha ?? null,
        tipo: esCredito ? "CREDITO" : "CONTADO",
        fecha_cobro: esCredito ? (fechaCobroPorVenta.get(String(v.id)) ?? null) : null,
        vendido: Math.round(ingresos),
        costo: Math.round(costo),
        ganancia: Math.round(ganancia),
      });
    }

    // =========================================================================
    // 5) Overrides por vendedor/mes: otro %, monto fijo y estado de pago.
    //    Sin fila -> 5% y "retenida". El mes se toma del inicio del rango.
    // =========================================================================
    const periodoMes = desde.slice(0, 7); // YYYY-MM
    type Override = { tipo: "porcentaje" | "monto_fijo"; valor: number; estado: string; observacion: string | null };
    const overridePorVendedor = new Map<string, Override>();
    try {
      const { data: ovs } = await sb
        .from("comision_periodo_vendedor")
        .select("vendedor, tipo, valor, estado, observacion")
        .eq("empresa_id", empresaId)
        .eq("periodo", periodoMes);
      for (const o of (ovs ?? []) as Array<Record<string, unknown>>) {
        overridePorVendedor.set(String(o.vendedor), {
          tipo: o.tipo === "monto_fijo" ? "monto_fijo" : "porcentaje",
          valor: Number(o.valor) || 0,
          estado: typeof o.estado === "string" ? o.estado : "retenida",
          observacion: typeof o.observacion === "string" ? o.observacion : null,
        });
      }
    } catch (e) {
      console.warn("[comisiones] overrides no disponibles:", e instanceof Error ? e.message : e);
    }

    const filas = [...porVendedor.values()]
      .map((a) => {
        const ov = overridePorVendedor.get(a.vendedor);
        const tipo = ov?.tipo ?? "porcentaje";
        const porcentaje = tipo === "porcentaje" ? (ov?.valor ?? PORCENTAJE_COMISION) : 0;
        const comision = tipo === "monto_fijo"
          ? Math.max(0, Math.round(ov?.valor ?? 0))
          : Math.max(0, Math.round((a.ganancia * porcentaje) / 100));
        return {
          vendedor: a.vendedor,
          ventas: a.ventas,
          ingresos: Math.round(a.ingresos),
          costo: Math.round(a.costo),
          ganancia: Math.round(a.ganancia),
          tipo,
          porcentaje,
          monto_fijo: tipo === "monto_fijo" ? Math.round(ov?.valor ?? 0) : null,
          estado: ov?.estado ?? "retenida",
          observacion: ov?.observacion ?? null,
          personalizado: !!ov,
          comision,
          detalle: a.detalle.slice().sort((x, y) => String(y.fecha ?? "").localeCompare(String(x.fecha ?? ""))),
        };
      })
      .sort((a, b) => b.ganancia - a.ganancia);

    return NextResponse.json(successResponse({
      periodo: { desde, hasta, mes: periodoMes },
      escalas: ESCALAS,
      por_vendedor: filas,
      totales: {
        ventas: filas.reduce((s, f) => s + f.ventas, 0),
        ingresos: filas.reduce((s, f) => s + f.ingresos, 0),
        costo: filas.reduce((s, f) => s + f.costo, 0),
        ganancia: filas.reduce((s, f) => s + f.ganancia, 0),
        comision: filas.reduce((s, f) => s + f.comision, 0),
        comision_liberada: filas.filter((f) => f.estado !== "retenida").reduce((s, f) => s + f.comision, 0),
      },
    }));
  } catch (err) {
    console.error("[/api/comisiones/ferretodo GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron calcular las comisiones."), { status: 500 });
  }
}
