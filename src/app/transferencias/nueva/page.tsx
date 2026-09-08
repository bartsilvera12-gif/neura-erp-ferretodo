"use client";

/**
 * Despacho de una transferencia interna.
 * Al confirmar, el stock SALE de esta empresa y queda en tránsito hasta que la
 * empresa destino confirme la recepción.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import MontoInput from "@/components/ui/MontoInput";

type Destino = { empresa_id: string; nombre: string };
type Prod = { id: string; nombre: string; sku: string; costo_promedio: number; stock_actual: number; unidad_medida: string };
type Linea = { producto: Prod; cantidad: number };

function fmtGs(v: number) {
  return `Gs. ${Math.round(v || 0).toLocaleString("es-PY")}`;
}

export default function NuevaTransferenciaPage() {
  const router = useRouter();
  const [destinos, setDestinos] = useState<Destino[]>([]);
  const [destinoId, setDestinoId] = useState("");
  const [observacion, setObservacion] = useState("");
  const [tipoPago, setTipoPago] = useState<"contado" | "credito">("credito");
  const [plazoDias, setPlazoDias] = useState(30);
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Prod[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetchWithSupabaseSession("/api/transferencias/destinos", { cache: "no-store" });
        const j = await r.json();
        if (!r.ok || j?.success === false) throw new Error(j?.error ?? `Error ${r.status}`);
        const ds = (j.data?.destinos ?? []) as Destino[];
        setDestinos(ds);
        if (ds.length === 1) setDestinoId(ds[0].empresa_id);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "No se pudieron cargar las empresas.");
      }
    })();
  }, []);

  const buscar = useCallback((texto: string) => {
    setQ(texto);
    if (timer.current) clearTimeout(timer.current);
    if (texto.trim().length < 2) { setHits([]); return; }
    setBuscando(true);
    timer.current = setTimeout(async () => {
      try {
        const r = await fetchWithSupabaseSession(`/api/productos/search?q=${encodeURIComponent(texto.trim())}&limit=20`, { cache: "no-store" });
        const j = await r.json();
        setHits(((j?.data?.items ?? []) as Record<string, unknown>[]).map((p) => ({
          id: String(p.id),
          nombre: String(p.nombre ?? ""),
          sku: String(p.sku ?? ""),
          costo_promedio: Number(p.costo_promedio) || 0,
          stock_actual: Number(p.stock_actual) || 0,
          unidad_medida: String(p.unidad_medida ?? "Unidad"),
        })));
      } catch {
        setHits([]);
      } finally {
        setBuscando(false);
      }
    }, 250);
  }, []);

  function agregar(p: Prod) {
    setLineas((prev) => prev.some((l) => l.producto.id === p.id) ? prev : [...prev, { producto: p, cantidad: 1 }]);
    setQ("");
    setHits([]);
  }

  const total = lineas.reduce((s, l) => s + l.cantidad * l.producto.costo_promedio, 0);
  // Se avisa antes de mandar: el backend igual lo rechaza, pero es mejor verlo aca.
  const sinStock = lineas.filter((l) => l.cantidad > l.producto.stock_actual);

  async function confirmar() {
    setErr(null);
    if (!destinoId) return setErr("Elegí la empresa destino.");
    if (lineas.length === 0) return setErr("Agregá al menos un producto.");
    if (sinStock.length > 0) return setErr(`No hay stock suficiente de: ${sinStock.map((l) => l.producto.nombre).join(", ")}.`);
    setGuardando(true);
    try {
      const r = await fetchWithSupabaseSession("/api/transferencias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_destino_id: destinoId,
          tipo_pago: tipoPago,
          plazo_dias: tipoPago === "credito" ? plazoDias : null,
          observacion: observacion.trim() || null,
          items: lineas.map((l) => ({ producto_id: l.producto.id, cantidad: l.cantidad })),
        }),
      });
      const j = await r.json();
      if (!r.ok || j?.success === false) throw new Error(j?.error ?? `Error ${r.status}`);
      router.push(`/transferencias/${j.data.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo crear la transferencia.");
      setGuardando(false);
    }
  }

  const inputC = "rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30";

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Nueva transferencia</h1>
        <p className="mt-1 text-sm text-slate-500">
          La mercadería sale del stock al confirmar y queda en tránsito hasta que la otra empresa acepte la recepción. Se transfiere al costo actual, sin utilidad.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[11px] font-semibold text-slate-500">Empresa destino</label>
          <select value={destinoId} onChange={(e) => setDestinoId(e.target.value)} className={`${inputC} w-full`}>
            <option value="">Elegir…</option>
            {destinos.map((d) => <option key={d.empresa_id} value={d.empresa_id}>{d.nombre}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-semibold text-slate-500">Nota</label>
          <div className="flex items-center gap-2">
            <select value={tipoPago} onChange={(e) => setTipoPago(e.target.value as "contado" | "credito")} className={inputC}>
              <option value="credito">Crédito</option>
              <option value="contado">Contado</option>
            </select>
            {tipoPago === "credito" && (
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                a
                <input type="number" min={0} value={plazoDias}
                  onChange={(e) => setPlazoDias(Math.max(0, Number(e.target.value) || 0))}
                  className={`${inputC} w-20 tabular-nums`} />
                días
              </label>
            )}
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            {tipoPago === "contado"
              ? "Vence al recibirse: se paga en el momento."
              : "El plazo se cuenta desde que la otra empresa confirma la recepción."}
          </p>
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-[11px] font-semibold text-slate-500">Observación (opcional)</label>
          <input value={observacion} onChange={(e) => setObservacion(e.target.value)} className={`${inputC} w-full`} placeholder="Ej: pedido urgente de obra" />
        </div>
      </div>

      <div className="relative">
        <label className="mb-1 block text-[11px] font-semibold text-slate-500">Buscar producto</label>
        <input value={q} onChange={(e) => buscar(e.target.value)} className={`${inputC} w-full`} placeholder="Nombre o código…" />
        {buscando && <Loader2 className="absolute right-3 top-8 h-4 w-4 animate-spin text-slate-400" />}
        {hits.length > 0 && (
          <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            {hits.map((p) => (
              <button key={p.id} type="button" onClick={() => agregar(p)} className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50">
                <span className="font-medium text-slate-800">{p.nombre}</span>
                {p.sku && <span className="ml-2 text-xs text-slate-400">{p.sku}</span>}
                <span className="ml-2 text-xs text-slate-500">stock {p.stock_actual}</span>
                <span className="ml-2 text-xs text-slate-400">costo {fmtGs(p.costo_promedio)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              {["Producto", "Stock", "Cantidad", "Costo unit.", "Costo total", ""].map((h, i) => (
                <th key={i} className={`px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-slate-500 ${i >= 1 && i <= 4 ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lineas.length === 0 ? (
              <tr><td colSpan={6} className="py-8 text-center text-sm text-slate-400">Buscá productos para agregarlos.</td></tr>
            ) : lineas.map((l, i) => {
              const falta = l.cantidad > l.producto.stock_actual;
              return (
                <tr key={l.producto.id} className={falta ? "bg-red-50/50" : ""}>
                  <td className="px-4 py-3">
                    <span className="font-medium text-slate-800">{l.producto.nombre}</span>
                    {l.producto.sku && <span className="ml-2 text-xs text-slate-400">{l.producto.sku}</span>}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums ${falta ? "font-semibold text-red-600" : "text-slate-500"}`}>{l.producto.stock_actual}</td>
                  <td className="px-4 py-3 text-right">
                    <MontoInput
                      value={l.cantidad}
                      onChange={(n) => setLineas((prev) => prev.map((x, k) => k === i ? { ...x, cantidad: Math.max(0, n) } : x))}
                      decimals={false}
                      className="w-24 rounded-md border border-slate-200 px-2 py-1 text-right text-sm tabular-nums outline-none focus:ring-2 focus:ring-[#4FAEB2]/30"
                    />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-500">{fmtGs(l.producto.costo_promedio)}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-slate-800">{fmtGs(l.cantidad * l.producto.costo_promedio)}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setLineas((prev) => prev.filter((_, k) => k !== i))} className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {lineas.length > 0 && (
            <tfoot className="border-t border-slate-200 bg-slate-50">
              <tr>
                <td colSpan={4} className="px-4 py-3 text-sm font-bold text-slate-700">Total a costo</td>
                <td className="px-4 py-3 text-right text-sm font-bold tabular-nums text-slate-900">{fmtGs(total)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
        </div>
      </div>

      {err && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

      <div className="flex justify-end gap-2">
        <button onClick={() => router.push("/transferencias")} className="rounded-md border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Cancelar</button>
        <button onClick={() => void confirmar()} disabled={guardando}
          className="inline-flex items-center gap-1.5 rounded-md bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50">
          {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Despachar transferencia
        </button>
      </div>
    </div>
  );
}
