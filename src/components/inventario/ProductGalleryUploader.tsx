"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Star, Trash2, ArrowUp, ArrowDown, ImagePlus, Loader2 } from "lucide-react";

interface ApiImage {
  id: string;
  url: string | null;
  storage_path: string;
  orden: number;
  es_principal: boolean;
}

interface Props {
  productoId: string;
}

const ACCEPT = "image/jpeg,image/png,image/webp";
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMG_BYTES = 5 * 1024 * 1024;
const MAX_IMAGENES = 8;

/**
 * Administra la galeria de imagenes de un producto EXISTENTE (pantalla Editar).
 * Todas las operaciones son server-mediated contra
 * /api/productos/[id]/imagenes(.../[imagenId]) y refrescan con la lista que
 * devuelve el backend (fuente de verdad, con URLs firmadas frescas).
 */
export default function ProductGalleryUploader({ productoId }: Props) {
  const [items, setItems] = useState<ApiImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(`/api/productos/${productoId}/imagenes`, { credentials: "include" });
        const json = await res.json();
        if (!cancel && res.ok && json?.success) setItems(json.data?.imagenes ?? []);
      } catch {
        /* placeholder si falla */
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [productoId]);

  const handleAdd = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (fileRef.current) fileRef.current.value = "";
      if (files.length === 0) return;
      setError(null);

      const cupo = MAX_IMAGENES - items.length;
      if (cupo <= 0) {
        setError(`Máximo ${MAX_IMAGENES} imágenes por producto.`);
        return;
      }
      const aSubir = files.slice(0, cupo);
      setBusy(true);
      try {
        for (const f of aSubir) {
          if (!ALLOWED_MIME.includes(f.type)) {
            setError("Formato no permitido. Usá JPG, PNG o WebP.");
            continue;
          }
          if (f.size > MAX_IMG_BYTES) {
            setError("Alguna imagen supera los 5 MB y se omitió.");
            continue;
          }
          const fd = new FormData();
          fd.append("file", f);
          const res = await fetch(`/api/productos/${productoId}/imagenes`, {
            method: "POST",
            body: fd,
            credentials: "include",
          });
          const json = await res.json();
          if (res.ok && json?.success) {
            setItems(json.data?.imagenes ?? []);
          } else {
            setError(json?.error ?? "No se pudo subir una imagen.");
          }
        }
        if (files.length > cupo) {
          setError(`Solo se subieron ${cupo}: el máximo es ${MAX_IMAGENES} imágenes.`);
        }
      } finally {
        setBusy(false);
      }
    },
    [items.length, productoId]
  );

  const handleRemove = useCallback(
    async (id: string) => {
      setError(null);
      setBusy(true);
      try {
        const res = await fetch(`/api/productos/${productoId}/imagenes/${id}`, {
          method: "DELETE",
          credentials: "include",
        });
        const json = await res.json();
        if (res.ok && json?.success) setItems(json.data?.imagenes ?? []);
        else setError(json?.error ?? "No se pudo eliminar la imagen.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error de red");
      } finally {
        setBusy(false);
      }
    },
    [productoId]
  );

  const handlePrincipal = useCallback(
    async (id: string) => {
      setError(null);
      setBusy(true);
      try {
        const res = await fetch(`/api/productos/${productoId}/imagenes`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ principalId: id }),
          credentials: "include",
        });
        const json = await res.json();
        if (res.ok && json?.success) setItems(json.data?.imagenes ?? []);
        else setError(json?.error ?? "No se pudo cambiar la principal.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error de red");
      } finally {
        setBusy(false);
      }
    },
    [productoId]
  );

  const handleMove = useCallback(
    async (index: number, dir: -1 | 1) => {
      const target = index + dir;
      if (target < 0 || target >= items.length) return;
      const next = [...items];
      [next[index], next[target]] = [next[target], next[index]];
      setItems(next); // optimista
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/productos/${productoId}/imagenes`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: next.map((it) => it.id) }),
          credentials: "include",
        });
        const json = await res.json();
        if (res.ok && json?.success) setItems(json.data?.imagenes ?? []);
        else setError(json?.error ?? "No se pudo reordenar.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error de red");
      } finally {
        setBusy(false);
      }
    },
    [items, productoId]
  );

  if (loading) {
    return <p className="text-sm text-slate-400">Cargando imágenes…</p>;
  }

  return (
    <div className="space-y-3">
      {items.length > 0 && (
        <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {items.map((it, i) => (
            <li
              key={it.id}
              className={`group relative rounded-xl border overflow-hidden bg-slate-50 ${
                it.es_principal ? "border-[#0EA5E9] ring-1 ring-[#0EA5E9]" : "border-slate-200"
              }`}
            >
              <div className="aspect-square flex items-center justify-center overflow-hidden">
                {it.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.url} alt="Imagen del producto" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-xs text-slate-400">sin vista previa</span>
                )}
              </div>

              {it.es_principal && (
                <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-[#0EA5E9] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  <Star className="h-3 w-3 fill-current" /> Principal
                </span>
              )}

              <div className="flex items-center justify-between gap-1 px-1.5 py-1 bg-white border-t border-slate-100">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    title="Mover antes"
                    disabled={busy || i === 0}
                    onClick={() => handleMove(i, -1)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="Mover después"
                    disabled={busy || i === items.length - 1}
                    onClick={() => handleMove(i, 1)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    title={it.es_principal ? "Es la principal" : "Marcar como principal"}
                    disabled={busy || it.es_principal}
                    onClick={() => handlePrincipal(it.id)}
                    className={`inline-flex h-7 w-7 items-center justify-center rounded hover:bg-amber-50 disabled:opacity-40 ${
                      it.es_principal ? "text-amber-500" : "text-slate-400 hover:text-amber-500"
                    }`}
                  >
                    <Star className={`h-4 w-4 ${it.es_principal ? "fill-current" : ""}`} />
                  </button>
                  <button
                    type="button"
                    title="Eliminar imagen"
                    disabled={busy}
                    onClick={() => handleRemove(it.id)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-red-500 hover:bg-red-50 disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy || items.length >= MAX_IMAGENES}
          className="inline-flex items-center gap-2 rounded-lg bg-[#0EA5E9] px-4 py-2 text-sm text-white hover:bg-[#0284C7] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
          {items.length === 0 ? "Agregar imágenes" : "Agregar más"}
        </button>
        <span className="text-xs text-slate-400">
          {items.length}/{MAX_IMAGENES} · JPG, PNG o WebP — máx. 5 MB c/u
        </span>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={handleAdd}
        />
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {items.length === 0 && !error && (
        <p className="text-xs text-slate-400">
          Sin imágenes. La primera que subas será la principal (podés cambiarla luego).
        </p>
      )}
    </div>
  );
}
