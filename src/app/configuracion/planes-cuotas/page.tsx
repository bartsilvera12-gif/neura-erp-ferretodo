"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

const inputClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#0EA5E9] outline-none";

type PlanRow = { cuotas: string; recargo: string };
type PlanApi = { producto_id: string | null; cuotas: number; recargo_porcentaje: number };
type ProductoHit = { id: string; nombre: string; sku: string };

/** Editor de una lista de planes (cuotas + % recargo) de un alcance: general o un producto. */
function EditorPlanes(props: {
  titulo: string;
  ayuda: string;
  productoId: string | null;
  planes: PlanApi[];
  onSaved: () => void;
}) {
  const { productoId, planes, onSaved } = props;
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    setRows(
      planes
        .filter((p) => p.producto_id === productoId)
        .map((p) => ({ cuotas: String(p.cuotas), recargo: String(p.recargo_porcentaje) }))
    );
    setMsg(null);
  }, [planes, productoId]);

  function setRow(i: number, patch: Partial<PlanRow>) {
    setRows((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  }

  async function guardar() {
    setMsg(null);
    setGuardando(true);
    try {
      const res = await fetchWithSupabaseSession("/api/planes-cuotas", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          producto_id: productoId,
          planes: rows
            .filter((r) => r.cuotas.trim() !== "")
            .map((r) => ({ cuotas: Number(r.cuotas), recargo_porcentaje: Number(r.recargo) || 0 })),
        }),
      });
      const j = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !j.success) {
        setMsg({ ok: false, text: j.error ?? "No se pudo guardar." });
        return;
      }
      setMsg({ ok: true, text: "Planes guardados." });
      onSaved();
    } catch {
      setMsg({ ok: false, text: "No se pudo guardar." });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">{props.titulo}</h2>
        <p className="text-xs text-slate-500">{props.ayuda}</p>
      </div>
      {rows.length === 0 && <p className="text-xs text-slate-500">Sin planes cargados.</p>}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Cantidad de cuotas</label>
            <input
              type="number" min={2} max={60} className={inputClass} value={r.cuotas}
              onChange={(e) => setRow(i, { cuotas: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Recargo %</label>
            <input
              type="number" min={0} step="0.01" className={inputClass} value={r.recargo}
              onChange={(e) => setRow(i, { recargo: e.target.value })}
            />
          </div>
          <button
            type="button"
            onClick={() => setRows((prev) => prev.filter((_, k) => k !== i))}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
          >
            Quitar
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setRows((prev) => [...prev, { cuotas: "", recargo: "0" }])}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Agregar plan
        </button>
        <button
          type="button"
          disabled={guardando}
          onClick={guardar}
          className="rounded-lg bg-[#0EA5E9] px-4 py-2 text-sm font-semibold text-white hover:bg-sky-600 disabled:opacity-50"
        >
          Guardar planes
        </button>
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

export default function PlanesCuotasPage() {
  const [planes, setPlanes] = useState<PlanApi[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProductoHit[]>([]);
  const [producto, setProducto] = useState<ProductoHit | null>(null);

  const cargar = useCallback(async () => {
    try {
      const res = await fetchWithSupabaseSession("/api/planes-cuotas", { cache: "no-store" });
      const j = (await res.json()) as { data?: { planes?: PlanApi[] } };
      setPlanes(j.data?.planes ?? []);
    } catch {
      setPlanes([]);
    }
  }, []);
  useEffect(() => { void cargar(); }, [cargar]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await fetchWithSupabaseSession(`/api/productos/search?q=${encodeURIComponent(q)}&limit=8`, { cache: "no-store" });
        const j = await res.json();
        const items = ((j?.data?.items ?? []) as Record<string, unknown>[]).map((p) => ({
          id: String(p.id), nombre: String(p.nombre ?? ""), sku: String(p.sku ?? ""),
        }));
        setHits(items);
      } catch {
        setHits([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const conPlanPropio = Array.from(new Set(planes.filter((p) => p.producto_id).map((p) => p.producto_id)));

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-10 sm:px-6 lg:px-8">
      <div>
        <Link href="/configuracion" className="text-sm text-sky-600 hover:underline">← Configuración</Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Planes de cuotas</h1>
        <p className="text-sm text-slate-600">
          Definí cuántas cuotas se ofrecen y el porcentaje de recargo de cada una. En la venta, cada producto se puede
          vender al contado o con su propio plan; el sistema calcula el precio final y el valor de cada cuota.
        </p>
      </div>

      <EditorPlanes
        titulo="Planes generales"
        ayuda="Se ofrecen en todos los productos que no tengan planes propios."
        productoId={null}
        planes={planes}
        onSaved={cargar}
      />

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Planes por producto</h2>
          <p className="text-xs text-slate-500">
            Un producto con planes propios usa solo esos (no los generales). Si lo dejás sin planes vuelve a usar los generales.
            {conPlanPropio.length > 0 ? ` Productos con planes propios: ${conPlanPropio.length}.` : ""}
          </p>
        </div>
        {producto ? (
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span className="font-medium text-slate-800">{producto.nombre} <span className="font-mono text-xs text-slate-500">{producto.sku}</span></span>
            <button type="button" onClick={() => { setProducto(null); setQuery(""); }} className="text-xs text-sky-600 hover:underline">
              Cambiar producto
            </button>
          </div>
        ) : (
          <div className="relative">
            <input
              className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar producto por nombre o código…"
            />
            {hits.length > 0 && (
              <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                {hits.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => { setProducto(h); setHits([]); }}
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      {h.nombre} <span className="font-mono text-xs text-slate-500">{h.sku}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {producto && (
          <EditorPlanes
            titulo={`Planes de ${producto.nombre}`}
            ayuda="Solo para este producto."
            productoId={producto.id}
            planes={planes}
            onSaved={cargar}
          />
        )}
      </div>
    </div>
  );
}
