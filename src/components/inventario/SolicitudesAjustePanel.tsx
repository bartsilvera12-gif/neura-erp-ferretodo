"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Check, X, ClipboardList } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { useIsAdmin } from "@/lib/auth/use-is-admin";

type Solicitud = {
  id: string;
  producto_nombre: string;
  producto_sku: string | null;
  tipo: "ENTRADA" | "SALIDA" | "AJUSTE";
  cantidad: number;
  motivo: string | null;
  solicitado_por_nombre: string | null;
  created_at: string;
};

function fmtFechaHora(iso: string): string {
  try { return new Date(iso).toLocaleString("es-PY"); } catch { return iso; }
}

/**
 * Panel de solicitudes de ajuste de stock pendientes. Solo visible para admin.
 * Muestra quién pidió, qué producto y qué movimiento, con Aprobar / Rechazar.
 */
export function SolicitudesAjustePanel({ onCambio }: { onCambio?: () => void }) {
  const { isAdmin, loaded } = useIsAdmin();
  const [solicitudes, setSolicitudes] = useState<Solicitud[]>([]);
  const [cargando, setCargando] = useState(true);
  const [procesando, setProcesando] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetchWithSupabaseSession("/api/inventario/ajuste-stock/solicitudes?estado=pendiente", { cache: "no-store" });
      const j = await res.json();
      if (res.ok && j?.success !== false) setSolicitudes((j.data?.solicitudes ?? []) as Solicitud[]);
    } catch { /* noop */ }
    finally { setCargando(false); }
  }, []);

  useEffect(() => { if (isAdmin) void cargar(); }, [isAdmin, cargar]);

  async function resolver(id: string, accion: "aprobar" | "rechazar") {
    if (accion === "rechazar" && !confirm("¿Rechazar esta solicitud de ajuste de stock?")) return;
    setProcesando(id);
    try {
      const res = await fetchWithSupabaseSession(`/api/inventario/ajuste-stock/solicitudes/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion }),
      });
      const j = await res.json();
      if (!res.ok || j?.success === false) {
        setToast(`Error: ${j?.error ?? "no se pudo resolver"}`);
        setTimeout(() => setToast(null), 3000);
        return;
      }
      setToast(accion === "aprobar" ? "Solicitud aprobada — stock actualizado" : "Solicitud rechazada");
      setTimeout(() => setToast(null), 2800);
      await cargar();
      onCambio?.();
    } catch {
      setToast("Error de red.");
      setTimeout(() => setToast(null), 3000);
    } finally {
      setProcesando(null);
    }
  }

  // Solo admin. Si no hay pendientes, no ocupa espacio.
  if (!loaded || !isAdmin) return null;
  if (!cargando && solicitudes.length === 0) return null;

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm">
      {toast && (
        <div className="fixed top-4 right-4 z-50 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-white shadow-lg">{toast}</div>
      )}
      <div className="mb-3 flex items-center gap-2">
        <ClipboardList className="h-4 w-4 text-amber-700" />
        <h3 className="text-sm font-semibold text-amber-900">
          Solicitudes de ajuste de stock pendientes {solicitudes.length > 0 && `(${solicitudes.length})`}
        </h3>
      </div>
      {cargando ? (
        <div className="flex items-center gap-2 py-4 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>
      ) : (
        <div className="space-y-2">
          {solicitudes.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white px-3 py-2.5">
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium text-slate-800">
                  {s.producto_nombre}
                  {s.producto_sku ? <span className="ml-1 text-xs text-slate-400">{s.producto_sku}</span> : null}
                </p>
                <p className="text-xs text-slate-600">
                  <span className={`font-semibold ${s.tipo === "ENTRADA" ? "text-emerald-700" : s.tipo === "SALIDA" ? "text-red-600" : "text-amber-700"}`}>{s.tipo} {s.cantidad}</span>
                  {" · "}Solicitado por <span className="font-medium">{s.solicitado_por_nombre ?? "—"}</span>
                  {" · "}{fmtFechaHora(s.created_at)}
                </p>
                {s.motivo ? <p className="mt-0.5 text-xs italic text-slate-500">Motivo: {s.motivo}</p> : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" disabled={procesando === s.id} onClick={() => void resolver(s.id, "aprobar")}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                  <Check className="h-3.5 w-3.5" /> Aprobar
                </button>
                <button type="button" disabled={procesando === s.id} onClick={() => void resolver(s.id, "rechazar")}
                  className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50">
                  <X className="h-3.5 w-3.5" /> Rechazar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
