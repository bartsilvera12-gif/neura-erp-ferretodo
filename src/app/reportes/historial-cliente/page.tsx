"use client";

/**
 * Historial de compras por cliente: todo lo que un cliente se llevó en un rango
 * de fechas, con resumen por producto y detalle venta por venta. Pensado para
 * imprimirlo y mostrárselo al cliente en obra.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Printer, ArrowLeft } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type ItemVenta = { producto: string; sku: string | null; cantidad: number; precio: number; total: number };
type Venta = { id: string; numero_control: string; fecha: string; tipo_venta: string | null; total: number; items: ItemVenta[] };
type PorProducto = { producto: string; sku: string | null; cantidad: number; total: number };
type Payload = {
  cliente: { id: string; nombre: string; ruc: string | null; telefono: string | null; direccion: string | null };
  periodo: { desde: string; hasta: string };
  ventas: Venta[];
  por_producto: PorProducto[];
  totales: { ventas: number; unidades: number; total: number };
};

function fmtGs(v: number) {
  return `Gs. ${Math.round(v || 0).toLocaleString("es-PY")}`;
}
function fmtCant(v: number) {
  return Number(v).toLocaleString("es-PY", { maximumFractionDigits: 3 });
}
function fmtFecha(iso: string) {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  } catch { return iso; }
}
function inicioFinMes(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  const y = d.getFullYear(), m = d.getMonth();
  const fin = new Date(y, m + 1, 0);
  return { desde: `${y}-${p(m + 1)}-01`, hasta: `${y}-${p(m + 1)}-${p(fin.getDate())}` };
}

export default function HistorialClientePage() {
  const [clientes, setClientes] = useState<{ id: string; nombre: string }[]>([]);
  const [clienteId, setClienteId] = useState("");
  const [rango, setRango] = useState(() => inicioFinMes(new Date()));
  const [data, setData] = useState<Payload | null>(null);
  const [cargando, setCargando] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [verDetalle, setVerDetalle] = useState(true);

  useEffect(() => {
    fetchWithSupabaseSession("/api/clientes", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!j?.success || !Array.isArray(j.data)) return;
        const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
        setClientes(
          (j.data as Record<string, unknown>[])
            .map((c) => ({ id: String(c.id), nombre: s(c.empresa) || s(c.nombre_contacto) || s(c.nombre) || "Cliente" }))
            .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
        );
      })
      .catch(() => undefined);
  }, []);

  const cargar = useCallback(async () => {
    if (!clienteId) { setErr("Elegí un cliente."); return; }
    setCargando(true); setErr(null);
    try {
      const r = await fetchWithSupabaseSession(
        `/api/reportes/historial-cliente?cliente_id=${clienteId}&desde=${rango.desde}&hasta=${rango.hasta}`,
        { cache: "no-store" }
      );
      const j = await r.json();
      if (!r.ok || j?.success === false) throw new Error(j?.error ?? `Error ${r.status}`);
      setData(j.data as Payload);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
      setData(null);
    } finally {
      setCargando(false);
    }
  }, [clienteId, rango]);

  const inputC = "rounded-md border border-slate-200 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30";

  return (
    <div className="space-y-6">
      <div className="print:hidden">
        <Link href="/reportes" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" /> Reportes
        </Link>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Historial de compras por cliente</h1>
          <p className="mt-1 text-sm text-slate-500">Todo lo que se llevó en el período, con el detalle de cada venta.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2 print:hidden">
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-slate-500">Cliente</label>
            <select value={clienteId} onChange={(e) => setClienteId(e.target.value)} className={`${inputC} min-w-56`}>
              <option value="">— Elegí un cliente —</option>
              {clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-slate-500">Desde</label>
            <input type="date" value={rango.desde} onChange={(e) => setRango((r) => ({ ...r, desde: e.target.value }))} className={inputC} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-slate-500">Hasta</label>
            <input type="date" value={rango.hasta} onChange={(e) => setRango((r) => ({ ...r, hasta: e.target.value }))} className={inputC} />
          </div>
          <button onClick={() => void cargar()} disabled={cargando}
            className="rounded-md bg-[#4FAEB2] px-4 py-1.5 text-sm font-bold text-white hover:bg-[#3F8E91] disabled:opacity-50">
            {cargando ? "Buscando…" : "Buscar"}
          </button>
          {data && (
            <button onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              <Printer className="h-4 w-4" /> Imprimir
            </button>
          )}
        </div>
      </div>

      {err && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 print:hidden">{err}</div>}

      {data && (
        <>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Cliente</p>
                <p className="text-lg font-bold text-slate-900">{data.cliente.nombre}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {data.cliente.ruc && <>RUC/CI {data.cliente.ruc}</>}
                  {data.cliente.telefono && <> · Tel {data.cliente.telefono}</>}
                  {data.cliente.direccion && <> · {data.cliente.direccion}</>}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Período</p>
                <p className="text-sm font-semibold text-slate-700">{fmtFecha(data.periodo.desde)} — {fmtFecha(data.periodo.hasta)}</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 border-t border-slate-100 pt-4">
              <div><p className="text-[11px] uppercase text-slate-400">Compras</p><p className="text-xl font-bold text-slate-900">{data.totales.ventas}</p></div>
              <div><p className="text-[11px] uppercase text-slate-400">Unidades</p><p className="text-xl font-bold text-slate-900">{fmtCant(data.totales.unidades)}</p></div>
              <div><p className="text-[11px] uppercase text-slate-400">Total gastado</p><p className="text-xl font-bold text-[#3F8E91]">{fmtGs(data.totales.total)}</p></div>
            </div>
          </div>

          {data.ventas.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white py-12 text-center text-sm text-slate-400">
              Este cliente no compró nada en el período elegido.
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-5 py-3">
                  <h2 className="text-sm font-bold text-slate-800">Resumen por producto</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">Producto</th>
                        <th className="px-4 py-2.5 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Cantidad</th>
                        <th className="px-4 py-2.5 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.por_producto.map((p, i) => (
                        <tr key={i}>
                          <td className="px-4 py-2.5 text-slate-800">
                            {p.producto}
                            {p.sku && <span className="ml-2 font-mono text-[11px] text-slate-400">{p.sku}</span>}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{fmtCant(p.cantidad)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900">{fmtGs(p.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t border-slate-200 bg-slate-50">
                      <tr>
                        <td className="px-4 py-2.5 text-sm font-bold text-slate-700">Total</td>
                        <td className="px-4 py-2.5 text-right text-sm font-bold tabular-nums text-slate-700">{fmtCant(data.totales.unidades)}</td>
                        <td className="px-4 py-2.5 text-right text-sm font-bold tabular-nums text-slate-900">{fmtGs(data.totales.total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
                  <h2 className="text-sm font-bold text-slate-800">Detalle por compra</h2>
                  <label className="flex items-center gap-2 text-xs text-slate-600 print:hidden">
                    <input type="checkbox" checked={verDetalle} onChange={(e) => setVerDetalle(e.target.checked)} />
                    Mostrar productos de cada compra
                  </label>
                </div>
                <div className="divide-y divide-slate-100">
                  {data.ventas.map((v) => (
                    <div key={v.id} className="px-5 py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div className="flex items-baseline gap-3">
                          <span className="font-mono text-xs text-slate-500">{v.numero_control}</span>
                          <span className="text-sm text-slate-700">{fmtFecha(v.fecha)}</span>
                          {v.tipo_venta === "CREDITO" && (
                            <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-bold uppercase text-orange-700">Crédito</span>
                          )}
                        </div>
                        <span className="font-bold tabular-nums text-slate-900">{fmtGs(v.total)}</span>
                      </div>
                      {verDetalle && v.items.length > 0 && (
                        <ul className="mt-2 space-y-0.5 border-l-2 border-slate-100 pl-3">
                          {v.items.map((it, i) => (
                            <li key={i} className="flex justify-between gap-3 text-xs text-slate-600">
                              <span>{fmtCant(it.cantidad)} × {it.producto}</span>
                              <span className="tabular-nums">{fmtGs(it.total)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
