"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Star, Trash2, ArrowUp, ArrowDown, ImagePlus } from "lucide-react";

export interface PendingImagesPayload {
  /** Archivos en el orden de visualizacion elegido. */
  files: File[];
  /** Indice (dentro de files) de la imagen marcada como principal. */
  principalIndex: number;
}

interface Props {
  onChange?: (payload: PendingImagesPayload) => void;
}

interface Item {
  id: string;
  file: File;
  url: string;
  principal: boolean;
}

const ACCEPT = "image/jpeg,image/png,image/webp";
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMG_BYTES = 5 * 1024 * 1024;
const MAX_IMAGENES = 8;

/**
 * Selector de imagenes para producto NUEVO (todavia sin id). Mantiene los
 * archivos en memoria con previews y permite elegir principal, reordenar y
 * quitar. El formulario padre sube estos archivos al backend DESPUES de crear
 * el producto (cuando ya existe el id), en el orden elegido.
 */
export default function ProductImagesPicker({ onChange }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Notificar al padre en cada cambio.
  useEffect(() => {
    if (!onChange) return;
    const principalIndex = Math.max(0, items.findIndex((it) => it.principal));
    onChange({ files: items.map((it) => it.file), principalIndex: items.length ? principalIndex : 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Revocar object URLs al desmontar.
  useEffect(() => {
    return () => {
      items.forEach((it) => URL.revokeObjectURL(it.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const conUnaPrincipal = (list: Item[]): Item[] =>
    list.length > 0 && !list.some((it) => it.principal)
      ? list.map((it, idx) => (idx === 0 ? { ...it, principal: true } : it))
      : list;

  const handleAdd = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (fileRef.current) fileRef.current.value = "";
      if (files.length === 0) return;
      setError(null);

      const cupo = MAX_IMAGENES - items.length;
      if (cupo <= 0) {
        setError(`Máximo ${MAX_IMAGENES} imágenes por producto.`);
        return;
      }
      const nuevos: Item[] = [];
      let msg: string | null = null;
      for (const f of files.slice(0, cupo)) {
        if (!ALLOWED_MIME.includes(f.type)) {
          msg = "Formato no permitido. Usá JPG, PNG o WebP.";
          continue;
        }
        if (f.size > MAX_IMG_BYTES) {
          msg = "Alguna imagen supera los 5 MB y se omitió.";
          continue;
        }
        nuevos.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file: f,
          url: URL.createObjectURL(f),
          principal: false,
        });
      }
      if (files.length > cupo) msg = `Solo se agregaron ${cupo}: el máximo es ${MAX_IMAGENES}.`;
      if (msg) setError(msg);
      if (nuevos.length === 0) return;
      setItems((prev) => conUnaPrincipal([...prev, ...nuevos]));
    },
    [items.length]
  );

  const handleRemove = useCallback(
    (id: string) => {
      const found = items.find((it) => it.id === id);
      if (found) URL.revokeObjectURL(found.url);
      setItems((prev) => conUnaPrincipal(prev.filter((it) => it.id !== id)));
    },
    [items]
  );

  const handlePrincipal = useCallback((id: string) => {
    setItems((prev) => prev.map((it) => ({ ...it, principal: it.id === id })));
  }, []);

  const handleMove = useCallback((index: number, dir: -1 | 1) => {
    setItems((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  return (
    <div className="space-y-3">
      {items.length > 0 && (
        <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {items.map((it, i) => (
            <li
              key={it.id}
              className={`relative rounded-xl border overflow-hidden bg-slate-50 ${
                it.principal ? "border-[#0EA5E9] ring-1 ring-[#0EA5E9]" : "border-slate-200"
              }`}
            >
              <div className="aspect-square flex items-center justify-center overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={it.url} alt="Vista previa" className="w-full h-full object-cover" />
              </div>
              {it.principal && (
                <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-[#0EA5E9] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  <Star className="h-3 w-3 fill-current" /> Principal
                </span>
              )}
              <div className="flex items-center justify-between gap-1 px-1.5 py-1 bg-white border-t border-slate-100">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    title="Mover antes"
                    disabled={i === 0}
                    onClick={() => handleMove(i, -1)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    title="Mover después"
                    disabled={i === items.length - 1}
                    onClick={() => handleMove(i, 1)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    title={it.principal ? "Es la principal" : "Marcar como principal"}
                    disabled={it.principal}
                    onClick={() => handlePrincipal(it.id)}
                    className={`inline-flex h-7 w-7 items-center justify-center rounded hover:bg-amber-50 disabled:opacity-40 ${
                      it.principal ? "text-amber-500" : "text-slate-400 hover:text-amber-500"
                    }`}
                  >
                    <Star className={`h-4 w-4 ${it.principal ? "fill-current" : ""}`} />
                  </button>
                  <button
                    type="button"
                    title="Quitar"
                    onClick={() => handleRemove(it.id)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-red-500 hover:bg-red-50"
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
          disabled={items.length >= MAX_IMAGENES}
          className="inline-flex items-center gap-2 rounded-lg bg-[#0EA5E9] px-4 py-2 text-sm text-white hover:bg-[#0284C7] disabled:opacity-50"
        >
          <ImagePlus className="h-4 w-4" />
          {items.length === 0 ? "Seleccionar imágenes" : "Agregar más"}
        </button>
        <span className="text-xs text-slate-400">
          {items.length}/{MAX_IMAGENES} · JPG, PNG o WebP — máx. 5 MB c/u
        </span>
        <input ref={fileRef} type="file" accept={ACCEPT} multiple className="hidden" onChange={handleAdd} />
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      <p className="text-xs text-slate-400">
        Las imágenes se asociarán al producto al guardarlo. Podés cargar varias (opcional) y elegir la principal.
      </p>
    </div>
  );
}
