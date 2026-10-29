"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Download, ChevronDown, ChevronUp, X, Ban } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { RegistrarCobroModalCxc, type CxcRef } from "@/components/cobros/RegistrarCobroModalCxc";
import { useIsAdmin } from "@/lib/auth/use-is-admin";

type Mov = {
  id: string;
  venta_id: string | null;
  numero_venta: string | null;
  fecha_emision: string | null;
  fecha_vencimiento: string | null;
  total: number;
  cobrado: number;
  saldo: number;
  estado: string;
  vencida: boolean;
};
type Resumen = { total_vendido: number; saldo_pendiente: number; total_cobrado: number; vencido: number };
type DetalleItem = { producto_nombre: string; sku: string | null; cantidad: number; precio_venta: number; tipo_iva: string; total_linea: number };

const ESTADO_BADGE: Record<string, string> = {
  pendiente: "bg-amber-100 text-amber-700",
  parcial: "bg-sky-100 text-sky-700",
  pagado: "bg-emerald-100 text-emerald-700",
  vencido: "bg-red-100 text-red-700",
  anulado: "bg-slate-100 text-slate-500",
};

function fmtGs(n: number) {
  return "Gs. " + Math.round(Number(n) || 0).toLocaleString("es-PY");
}
function fmtFecha(iso: string | null) {
  if (!iso) return "—";
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split("-");
  return d && m && y ? `${d}/${m}/${y}` : s;
}
function diasMora(venc: string | null, vencida: boolean): number {
  if (!vencida || !venc) return 0;
  const hoy = new Date(new Date().toISOString().slice(0, 10));
  const v = new Date(String(venc).slice(0, 10));
  const diff = Math.floor((hoy.getTime() - v.getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

/**
 * Bloque de Estado de cuenta del cliente basado en cuentas_por_cobrar/cobros_clientes.
 * Muestra todas las cuentas tal cual (sin filtros), con cards de resumen y registro de cobro.
 */
export function EstadoCuentaClienteBlock({
  clienteId,
  onCambio,
}: {
  clienteId: string;
  onCambio?: () => void;
}) {
  const { isAdmin } = useIsAdmin();
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [movs, setMovs] = useState<Mov[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState(true);
  const [cobrando, setCobrando] = useState<CxcRef | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Anular un crédito (solo admin, créditos sin cobros): devuelve stock + deja Anulado.
  const [anular, setAnular] = useState<{ id: string; numero: string } | null>(null);
  const [anularMotivo, setAnularMotivo] = useState("");
  const [anulando, setAnulando] = useState(false);
  const [anularErr, setAnularErr] = useState<string | null>(null);
  // Detalle de una venta (qué llevó) al tocar el código de la venta.
  const [detalle, setDetalle] = useState<{ ventaId: string; numero: string } | null>(null);
  const [detalleItems, setDetalleItems] = useState<DetalleItem[]>([]);
  const [detalleLoad, setDetalleLoad] = useState(false);
  const [detalleErr, setDetalleErr] = useState<string | null>(null);
  // Edición inline de la fecha de vencimiento de un crédito.
  const [editVenc, setEditVenc] = useState<{ id: string; value: string } | null>(null);
  const [savingVenc, setSavingVenc] = useState(false);

  async function guardarVencimiento() {
    if (!editVenc) return;
    setSavingVenc(true);
    try {
      const res = await fetchWithSupabaseSession(`/api/cobros/cuentas/${editVenc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fecha_vencimiento: editVenc.value || null }),
      });
      const body = await res.json();
      if (!res.ok || body?.success === false) {
        setToast(`Error: ${body?.error ?? "no se pudo actualizar"}`);
        setTimeout(() => setToast(null), 3000);
        return;
      }
      setEditVenc(null);
      setToast("Vencimiento actualizado");
      setTimeout(() => setToast(null), 2500);
      await cargar();
    } catch {
      setToast("Error de red.");
      setTimeout(() => setToast(null), 3000);
    } finally {
      setSavingVenc(false);
    }
  }

  async function verDetalleVenta(ventaId: string, numero: string) {
    setDetalle({ ventaId, numero });
    setDetalleItems([]);
    setDetalleErr(null);
    setDetalleLoad(true);
    try {
      const res = await fetchWithSupabaseSession(`/api/ventas/${ventaId}/items`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || body?.success === false) {
        setDetalleErr(body?.error ?? "No se pudo cargar el detalle.");
        return;
      }
      setDetalleItems((body.data?.items ?? []) as DetalleItem[]);
    } catch {
      setDetalleErr("Error de red.");
    } finally {
      setDetalleLoad(false);
    }
  }

  async function confirmarAnular() {
    if (!anular) return;
    setAnulando(true);
    setAnularErr(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/cobros/cuentas/${anular.id}/anular`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: anularMotivo.trim() || null }),
      });
      const body = await res.json();
      if (!res.ok || body?.success === false) {
        setAnularErr(body?.error ?? "No se pudo anular el crédito.");
        return;
      }
      setAnular(null);
      setAnularMotivo("");
      setToast("Crédito anulado — stock devuelto");
      setTimeout(() => setToast(null), 2800);
      await cargar();
      onCambio?.();
    } catch {
      setAnularErr("Error de red.");
    } finally {
      setAnulando(false);
    }
  }

  const cargar = useCallback(async () => {
    if (!clienteId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithSupabaseSession(`/api/clientes/${clienteId}/estado-cuenta`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || body?.success === false) {
        setError(body?.error ?? "No se pudo cargar el estado de cuenta.");
        return;
      }
      setResumen(body.data.resumen);
      setMovs((body.data.movimientos ?? []) as Mov[]);
    } catch {
      setError("Error de red.");
    } finally {
      setLoading(false);
    }
  }, [clienteId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Resumen por cantidades (cada cuenta cae en exactamente un grupo).
  const m = useMemo(() => {
    const activas = movs.filter((x) => x.estado !== "anulado");
    const montoTotal = activas.reduce((a, x) => a + x.total, 0);
    const saldoPend = activas.reduce((a, x) => a + x.saldo, 0);
    const esPend = (x: Mov) => (x.estado === "pendiente" || x.estado === "parcial");
    const vencidas = activas.filter((x) => esPend(x) && x.vencida);
    const pendientes = activas.filter((x) => esPend(x) && !x.vencida);
    const pagadas = activas.filter((x) => x.estado === "pagado");
    return {
      cuentas: activas.length,
      montoTotal,
      saldoPend,
      vencidas: vencidas.length,
      pendientes: pendientes.length,
      pagadas: pagadas.length,
    };
  }, [movs]);

  const sinCuentas = !loading && movs.length === 0;

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      {toast && (
        <div className="fixed top-4 right-4 z-50 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg">✓ {toast}</div>
      )}

      {/* Cabecera tipo "FACTURAS del cliente" */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/60 bg-slate-50/90 px-3 py-2.5 sm:px-4">
        <button type="button" onClick={() => setAbierto((v) => !v)} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-left">
          <span className="inline-flex shrink-0 text-slate-500" aria-hidden>
            {abierto ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">Estado de cuenta</span>
          <span className="hidden text-[10px] font-normal text-slate-400 sm:inline">del cliente</span>
          <span className="hidden h-3 w-px bg-slate-200 sm:inline" />
          <span className="rounded-md bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-700 ring-1 ring-slate-200/80">{m.cuentas} cuenta{m.cuentas === 1 ? "" : "s"}</span>
          <span className="rounded-md bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-700 ring-1 ring-slate-200/80">Saldo {fmtGs(m.saldoPend)}</span>
          {m.vencidas > 0 ? (
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700 ring-1 ring-red-200/80">{m.vencidas} venc.</span>
          ) : null}
        </button>
        <a
          href={`/api/clientes/${clienteId}/estado-cuenta/pdf?auto=1`}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <Download className="h-3.5 w-3.5" /> Descargar
        </a>
      </div>

      {!abierto ? null : (
        <>
          {/* Cards de resumen */}
          <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 sm:p-4 lg:grid-cols-6">
            <Card label="Cuentas" value={String(m.cuentas)} />
            <Card label="Monto total" value={fmtGs(m.montoTotal)} />
            <Card label="Saldo pend." value={fmtGs(m.saldoPend)} valueClass={m.saldoPend > 0 ? "text-amber-600" : "text-emerald-600"} ring="ring-[#4FAEB2]/20" />
            <Card label="Vencidas" value={String(m.vencidas)} valueClass={m.vencidas > 0 ? "text-red-600" : "text-slate-800"} ring="ring-red-200/70" />
            <Card label="Pendientes" value={String(m.pendientes)} valueClass="text-amber-600" ring="ring-amber-200/70" />
            <Card label="Pagadas" value={String(m.pagadas)} valueClass="text-emerald-700" ring="ring-emerald-200/70" />
          </div>

          {error && <div className="mx-3 mb-3 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700 sm:mx-4">{error}</div>}

          {loading ? (
            <div className="p-8 flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
          ) : sinCuentas ? (
            <div className="p-8 text-center text-sm text-gray-500">El cliente no tiene cuentas pendientes.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="py-2.5 px-3 font-medium sm:px-4">Tipo</th>
                    <th className="py-2.5 px-3 font-medium">Venta</th>
                    <th className="py-2.5 px-3 font-medium">F. emisión</th>
                    <th className="py-2.5 px-3 font-medium">F. vencimiento</th>
                    <th className="py-2.5 px-3 font-medium text-right">Monto</th>
                    <th className="py-2.5 px-3 font-medium text-right">Cobrado</th>
                    <th className="py-2.5 px-3 font-medium text-right">Saldo</th>
                    <th className="py-2.5 px-3 font-medium text-center">Días mora</th>
                    <th className="py-2.5 px-3 font-medium">Estado</th>
                    <th className="py-2.5 px-3 font-medium text-right">Operación</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {movs.map((x) => {
                    const mora = diasMora(x.fecha_vencimiento, x.vencida);
                    const estadoVis = x.vencida && x.estado !== "pagado" && x.estado !== "anulado" ? "vencido" : x.estado;
                    return (
                      <tr key={x.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 sm:px-4">
                          <span className="inline-flex items-center gap-1.5 text-xs text-slate-600"><span className="h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" /> Crédito</span>
                        </td>
                        <td className="py-2.5 px-3 font-mono font-medium text-gray-800">
                          {x.venta_id ? (
                            <button
                              type="button"
                              onClick={() => void verDetalleVenta(x.venta_id as string, x.numero_venta ?? "")}
                              className="text-[#0EA5E9] hover:text-[#0284C7] hover:underline"
                              title="Ver qué llevó en esta venta"
                            >
                              {x.numero_venta ?? "Ver detalle"}
                            </button>
                          ) : (
                            x.numero_venta ?? "—"
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-gray-600">{fmtFecha(x.fecha_emision)}</td>
                        <td className={`py-2.5 px-3 ${x.vencida ? "font-semibold text-red-600" : "text-gray-600"}`}>
                          {editVenc?.id === x.id ? (
                            <span className="inline-flex items-center gap-1">
                              <input
                                type="date"
                                value={editVenc.value}
                                onChange={(e) => setEditVenc({ id: x.id, value: e.target.value })}
                                className="rounded-md border border-slate-300 px-1.5 py-1 text-xs"
                              />
                              <button type="button" disabled={savingVenc} onClick={() => void guardarVencimiento()} className="rounded-md bg-[#4FAEB2] px-2 py-1 text-[11px] font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50">
                                {savingVenc ? "…" : "Guardar"}
                              </button>
                              <button type="button" onClick={() => setEditVenc(null)} className="text-[11px] text-slate-400 hover:text-slate-600">Cancelar</button>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              {fmtFecha(x.fecha_vencimiento)}
                              {x.estado !== "anulado" && x.estado !== "pagado" && (
                                <button
                                  type="button"
                                  onClick={() => setEditVenc({ id: x.id, value: x.fecha_vencimiento ? String(x.fecha_vencimiento).slice(0, 10) : "" })}
                                  className="text-[11px] text-[#0EA5E9] hover:underline"
                                  title="Cambiar la fecha de vencimiento"
                                >
                                  editar
                                </button>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums">{fmtGs(x.total)}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-emerald-700">{fmtGs(x.cobrado)}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-amber-600">{fmtGs(x.saldo)}</td>
                        <td className={`py-2.5 px-3 text-center tabular-nums ${mora > 0 ? "font-semibold text-red-600" : "text-slate-400"}`}>{mora > 0 ? mora : "—"}</td>
                        <td className="py-2.5 px-3">
                          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${ESTADO_BADGE[estadoVis] ?? ESTADO_BADGE.pendiente}`}>
                            {estadoVis.charAt(0).toUpperCase() + estadoVis.slice(1)}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {x.estado === "pagado" || x.estado === "anulado" ? (
                            <span className="text-xs text-gray-400">—</span>
                          ) : (
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => setCobrando({ id: x.id, numero_venta: x.numero_venta, saldo: x.saldo })}
                                className="rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#3F8E91]"
                              >
                                Cobrar
                              </button>
                              {isAdmin && x.cobrado === 0 && (
                                <button
                                  onClick={() => { setAnular({ id: x.id, numero: x.numero_venta ?? "" }); setAnularMotivo(""); setAnularErr(null); }}
                                  className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                                  title="Anular este crédito y devolver los productos al stock"
                                >
                                  <Ban className="h-3.5 w-3.5" /> Anular
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50/90">
                    <td colSpan={4} className="px-3 py-2.5 text-xs text-slate-500 sm:px-4">
                      <span className="font-semibold text-slate-700">{m.cuentas}</span> cuenta{m.cuentas === 1 ? "" : "s"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Total</span>
                      <p className="text-sm font-bold tabular-nums text-slate-800">{fmtGs(m.montoTotal)}</p>
                    </td>
                    <td className="px-3 py-2.5" />
                    <td className="px-3 py-2.5 text-right">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Saldo</span>
                      <p className={`text-sm font-bold tabular-nums ${m.saldoPend > 0 ? "text-amber-600" : "text-emerald-700"}`}>{fmtGs(m.saldoPend)}</p>
                    </td>
                    <td colSpan={3} className="px-3 py-2.5" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}

      {detalle && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setDetalle(null)}>
          <div className="flex w-full max-w-lg max-h-[85vh] flex-col overflow-hidden rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-800">Detalle de la venta {detalle.numero}</h3>
              <button type="button" onClick={() => setDetalle(null)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Cerrar">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto p-4">
              {detalleLoad ? (
                <div className="flex items-center gap-2 py-6 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
              ) : detalleErr ? (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{detalleErr}</div>
              ) : detalleItems.length === 0 ? (
                <div className="py-6 text-center text-sm text-gray-500">Esta venta no tiene ítems.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-gray-500">
                    <tr>
                      <th className="px-2 py-2 text-center">Cant.</th>
                      <th className="px-2 py-2 text-left">Producto</th>
                      <th className="px-2 py-2 text-right">P. Unit.</th>
                      <th className="px-2 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {detalleItems.map((it, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1.5 text-center tabular-nums">{it.cantidad}</td>
                        <td className="px-2 py-1.5">{it.producto_nombre}{it.sku ? <span className="ml-1 text-[10px] text-slate-400">{it.sku}</span> : null}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{fmtGs(it.precio_venta)}</td>
                        <td className="px-2 py-1.5 text-right font-medium tabular-nums">{fmtGs(it.total_linea)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200">
                      <td colSpan={3} className="px-2 py-2 text-right font-semibold">Total</td>
                      <td className="px-2 py-2 text-right font-bold tabular-nums">{fmtGs(detalleItems.reduce((a, it) => a + it.total_linea, 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {anular && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => !anulando && setAnular(null)}>
          <div className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-red-700"><Ban className="h-4 w-4" /> Anular crédito {anular.numero}</h3>
              <button type="button" onClick={() => !anulando && setAnular(null)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Cerrar">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 p-4">
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                Se va a <strong>anular este crédito</strong>. Los productos de la venta <strong>vuelven al stock</strong> y la deuda queda en <strong>Gs. 0 (Anulado)</strong>. Esta acción no se puede deshacer.
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Motivo <span className="text-slate-400">(opcional)</span></label>
                <input
                  type="text"
                  value={anularMotivo}
                  onChange={(e) => setAnularMotivo(e.target.value)}
                  placeholder="Ej: el cliente devolvió la mercadería"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
                />
              </div>
              {anularErr && <div className="rounded-md border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">{anularErr}</div>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" disabled={anulando} onClick={() => setAnular(null)} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Cancelar
                </button>
                <button type="button" disabled={anulando} onClick={() => void confirmarAnular()} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                  {anulando ? <><Loader2 className="h-4 w-4 animate-spin" /> Anulando…</> : <>Anular crédito</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <RegistrarCobroModalCxc
        open={!!cobrando}
        cuenta={cobrando}
        onClose={() => setCobrando(null)}
        onExito={async () => {
          setToast("Pago registrado");
          setTimeout(() => setToast(null), 2800);
          await cargar();
          onCambio?.();
        }}
      />
    </section>
  );
}

function Card({ label, value, valueClass = "text-slate-800", ring = "ring-slate-200/70" }: { label: string; value: string; valueClass?: string; ring?: string }) {
  return (
    <div className={`rounded-lg border border-slate-200 bg-white px-3 py-2.5 ring-1 ${ring}`}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 text-sm font-bold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
