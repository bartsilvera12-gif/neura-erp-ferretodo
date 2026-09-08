"use client";

/**
 * Detalle de una transferencia. Si esta empresa es la receptora y sigue
 * pendiente, acá se hace la recepción: por cada línea el funcionario asigna el
 * producto de SU catálogo (o lo crea con su propio código) y recién ahí suma
 * al stock.
 */
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type Item = {
  id: string;
  sku_origen: string | null;
  nombre_origen: string;
  unidad_medida: string | null;
  cantidad: number;
  costo_unitario: number;
  sku_destino: string | null;
  producto_destino_creado: boolean;
};
type Trf = {
  id: string; numero: string; nombre_origen: string; nombre_destino: string;
  estado: "pendiente" | "recibido" | "cancelado"; observacion: string | null;
  total_costo: number; creada_at: string; creada_por_nombre: string | null;
  recibida_at: string | null; recibida_por_nombre: string | null;
  cancelada_at: string | null; cancelada_por_nombre: string | null; cancelada_motivo: string | null;
  rol: "origen" | "destino"; items: Item[];
};
type Sugerencia = { producto_id: string; nombre: string; sku: string | null } | null;
/** Decisión por línea: usar un producto que ya existe, o crear uno nuevo. */
type Asignacion = { modo: "existente" | "crear"; producto_id: string; sku: string; nombre: string };

function fmtGs(v: number) {
  return `Gs. ${Math.round(v || 0).toLocaleString("es-PY")}`;
}

export default function TransferenciaDetallePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [trf, setTrf] = useState<Trf | null>(null);
  const [sug, setSug] = useState<Record<string, Sugerencia>>({});
  const [asig, setAsig] = useState<Record<string, Asignacion>>({});
  const [cargando, setCargando] = useState(true);
  const [accion, setAccion] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const r = await fetchWithSupabaseSession(`/api/transferencias/${id}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || j?.success === false) throw new Error(j?.error ?? `Error ${r.status}`);
      const t = j.data.transferencia as Trf;
      const s = (j.data.sugerencias ?? {}) as Record<string, Sugerencia>;
      setTrf(t);
      setSug(s);
      // Precarga: si el código ya existe en este catálogo se propone ese
      // producto; si no, se propone crearlo con el mismo código y nombre.
      const inicial: Record<string, Asignacion> = {};
      for (const it of t.items ?? []) {
        const m = s[it.id];
        inicial[it.id] = m
          ? { modo: "existente", producto_id: m.producto_id, sku: m.sku ?? "", nombre: m.nombre }
          : { modo: "crear", producto_id: "", sku: it.sku_origen ?? "", nombre: it.nombre_origen };
      }
      setAsig(inicial);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setCargando(false);
    }
  }, [id]);

  useEffect(() => { void cargar(); }, [cargar]);

  async function recibir() {
    if (!trf) return;
    setErr(null);
    for (const it of trf.items) {
      const a = asig[it.id];
      if (!a) return setErr(`Falta definir "${it.nombre_origen}".`);
      if (a.modo === "existente" && !a.producto_id) return setErr(`Elegí el producto para "${it.nombre_origen}".`);
      if (a.modo === "crear" && (!a.sku.trim() || !a.nombre.trim())) {
        return setErr(`Cargá código y nombre para "${it.nombre_origen}".`);
      }
    }
    setAccion(true);
    try {
      const r = await fetchWithSupabaseSession(`/api/transferencias/${id}/recibir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asignaciones: trf.items.map((it) => {
            const a = asig[it.id];
            return a.modo === "existente"
              ? { item_id: it.id, producto_destino_id: a.producto_id }
              : { item_id: it.id, crear: { sku: a.sku.trim(), nombre: a.nombre.trim() } };
          }),
        }),
      });
      const j = await r.json();
      if (!r.ok || j?.success === false) throw new Error(j?.error ?? `Error ${r.status}`);
      await cargar();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo recibir.");
    } finally {
      setAccion(false);
    }
  }

  async function cancelar() {
    const motivo = window.prompt("Motivo de la cancelación (opcional):") ?? "";
    setAccion(true);
    setErr(null);
    try {
      const r = await fetchWithSupabaseSession(`/api/transferencias/${id}/cancelar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo }),
      });
      const j = await r.json();
      if (!r.ok || j?.success === false) throw new Error(j?.error ?? `Error ${r.status}`);
      await cargar();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo cancelar.");
    } finally {
      setAccion(false);
    }
  }

  if (cargando) return <div className="p-6 flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>;
  if (!trf) return (
    <div className="space-y-3 p-6">
      <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err ?? "Transferencia no encontrada"}</p>
      <Link href="/transferencias" className="text-sm text-[#4FAEB2] hover:underline">Volver</Link>
    </div>
  );

  const puedeRecibir = trf.rol === "destino" && trf.estado === "pendiente";
  const puedeCancelar = trf.estado === "pendiente";
  const inputC = "rounded-md border border-slate-200 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[#4FAEB2]/30";

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{trf.numero}</h1>
          <p className="mt-1 text-sm text-slate-600">{trf.nombre_origen} → {trf.nombre_destino}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Despachada el {String(trf.creada_at).slice(0, 10)} por {trf.creada_por_nombre ?? "—"} · Total a costo {fmtGs(trf.total_costo)}
          </p>
          {trf.observacion && <p className="mt-1 text-xs text-slate-500">Observación: {trf.observacion}</p>}
          {trf.estado === "recibido" && (
            <p className="mt-1 text-xs text-emerald-700">Recibida el {String(trf.recibida_at).slice(0, 10)} por {trf.recibida_por_nombre ?? "—"}</p>
          )}
          {trf.estado === "cancelado" && (
            <p className="mt-1 text-xs text-slate-500">
              Cancelada el {String(trf.cancelada_at).slice(0, 10)} por {trf.cancelada_por_nombre ?? "—"}
              {trf.cancelada_motivo ? ` · ${trf.cancelada_motivo}` : ""} · el stock volvió a {trf.nombre_origen}
            </p>
          )}
        </div>
        <Link href="/transferencias" className="text-sm text-[#4FAEB2] hover:underline">Volver</Link>
      </div>

      {puedeRecibir && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Esta mercadería está en tránsito. Asigná cada producto a tu catálogo y confirmá para que sume al stock de {trf.nombre_destino}.
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              {["Producto en " + trf.nombre_origen, "Cantidad", "Costo unit.", puedeRecibir ? "Producto en " + trf.nombre_destino : "Imputado a"].map((h, i) => (
                <th key={i} className={`px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-slate-500 ${i === 1 || i === 2 ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {trf.items.map((it) => {
              const a = asig[it.id];
              const s = sug[it.id];
              return (
                <tr key={it.id}>
                  <td className="px-4 py-3">
                    <span className="font-medium text-slate-800">{it.nombre_origen}</span>
                    {it.sku_origen && <span className="ml-2 text-xs text-slate-400">{it.sku_origen}</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700">{it.cantidad}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-500">{fmtGs(it.costo_unitario)}</td>
                  <td className="px-4 py-3">
                    {!puedeRecibir ? (
                      <span className="text-slate-600">
                        {it.sku_destino ?? "—"}
                        {it.producto_destino_creado && <span className="ml-2 text-[10px] rounded-full bg-sky-100 px-1.5 py-0.5 font-semibold text-sky-700">creado</span>}
                      </span>
                    ) : (
                      <div className="space-y-1.5">
                        <div className="flex gap-1">
                          {(["existente", "crear"] as const).map((m) => (
                            <button key={m} type="button"
                              onClick={() => setAsig((p) => ({ ...p, [it.id]: { ...p[it.id], modo: m } }))}
                              disabled={m === "existente" && !s}
                              className={`rounded-md px-2 py-1 text-[11px] font-medium ${a?.modo === m ? "bg-[#4FAEB2] text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"}`}>
                              {m === "existente" ? "Usar existente" : "Crear producto"}
                            </button>
                          ))}
                        </div>
                        {a?.modo === "existente" ? (
                          s ? (
                            <p className="text-xs text-slate-700">
                              {s.nombre} <span className="text-slate-400">{s.sku ?? ""}</span>
                            </p>
                          ) : (
                            <p className="text-xs text-slate-400">No hay ningún producto con ese código acá.</p>
                          )
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            <input value={a?.sku ?? ""} placeholder="Código"
                              onChange={(e) => setAsig((p) => ({ ...p, [it.id]: { ...p[it.id], sku: e.target.value } }))}
                              className={`${inputC} w-28`} />
                            <input value={a?.nombre ?? ""} placeholder="Nombre"
                              onChange={(e) => setAsig((p) => ({ ...p, [it.id]: { ...p[it.id], nombre: e.target.value } }))}
                              className={`${inputC} w-56`} />
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {err && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

      {(puedeRecibir || puedeCancelar) && (
        <div className="flex justify-end gap-2">
          {puedeCancelar && (
            <button onClick={() => void cancelar()} disabled={accion}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">
              <X className="h-4 w-4" /> Cancelar transferencia
            </button>
          )}
          {puedeRecibir && (
            <button onClick={() => void recibir()} disabled={accion}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50">
              {accion ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Confirmar recepción
            </button>
          )}
        </div>
      )}
    </div>
  );
}
