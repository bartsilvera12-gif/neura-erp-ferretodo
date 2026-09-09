-- ============================================================================
-- ferretodo.producto_imagenes — MULTIPLES imagenes por producto.
--
-- ADITIVA E IDEMPOTENTE. Solo schema `ferretodo`. No toca stock, ventas,
-- compras, costos ni inventario. La columna legacy `productos.imagen_path` /
-- `imagen_url` NO se elimina: se mantiene sincronizada con la imagen PRINCIPAL
-- de esta tabla para no romper ningun consumidor existente (buscador de
-- Ventas, sitio publico via resolverImagenesPublicas, etc.).
--
-- Patron copiado de las tablas Ferretodo recientes (devoluciones_venta /
-- transferencias): `empresa_id uuid NOT NULL` SIN FK a una tabla de empresas
-- (este deploy no tiene `zentra_erp.empresas`); el aislamiento es por
-- `empresa_id` en la app (service role) + RLS. `producto_id` referencia
-- `ferretodo.productos` con ON DELETE CASCADE para limpieza automatica.
--
-- RLS: se habilita SOLO si existe el helper compartido
-- public.puede_acceder_empresa(uuid) (el mismo que usan las policies de
-- ferretodo.productos). Si no existe, se omite RLS y el aislamiento queda por
-- app + empresa_id (identico a devoluciones_venta), sin inventar un sistema
-- de seguridad paralelo.
-- ============================================================================

-- ── 1) Tabla ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ferretodo.producto_imagenes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL,
  producto_id   uuid NOT NULL REFERENCES ferretodo.productos(id) ON DELETE CASCADE,
  url           text,                                   -- cache de URL (firmada o publica); puede ser null
  storage_path  text NOT NULL,                          -- ruta exacta en el bucket, para poder borrar el archivo
  orden         integer NOT NULL DEFAULT 0,             -- orden de visualizacion (0 = primera)
  es_principal  boolean NOT NULL DEFAULT false,         -- imagen usada en cards/listados/miniaturas
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ferretodo.producto_imagenes IS
  'Galeria de imagenes por producto. La principal se refleja en productos.imagen_path/imagen_url (compat).';

-- ── 2) Indices ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_producto_imagenes_empresa
  ON ferretodo.producto_imagenes (empresa_id);
CREATE INDEX IF NOT EXISTS idx_producto_imagenes_producto_orden
  ON ferretodo.producto_imagenes (empresa_id, producto_id, orden);
-- Evita filas duplicadas para el mismo archivo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_producto_imagenes_storage_path
  ON ferretodo.producto_imagenes (empresa_id, storage_path);
-- Como maximo UNA principal por producto.
CREATE UNIQUE INDEX IF NOT EXISTS uq_producto_imagenes_principal_unica
  ON ferretodo.producto_imagenes (empresa_id, producto_id)
  WHERE es_principal = true;

-- ── 3) Grants (PostgREST usa service_role; anon/authenticated quedan gateados por RLS si aplica) ──
GRANT SELECT, INSERT, UPDATE, DELETE ON ferretodo.producto_imagenes TO anon, authenticated, service_role;

-- ── 4) RLS: mismo patron que ferretodo.productos, solo si existe el helper ──────
DO $$
BEGIN
  IF to_regprocedure('public.puede_acceder_empresa(uuid)') IS NOT NULL THEN
    ALTER TABLE ferretodo.producto_imagenes ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='ferretodo' AND tablename='producto_imagenes' AND policyname='producto_imagenes_select') THEN
      CREATE POLICY "producto_imagenes_select" ON ferretodo.producto_imagenes
        FOR SELECT USING (public.puede_acceder_empresa(empresa_id));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='ferretodo' AND tablename='producto_imagenes' AND policyname='producto_imagenes_insert') THEN
      CREATE POLICY "producto_imagenes_insert" ON ferretodo.producto_imagenes
        FOR INSERT WITH CHECK (public.puede_acceder_empresa(empresa_id));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='ferretodo' AND tablename='producto_imagenes' AND policyname='producto_imagenes_update') THEN
      CREATE POLICY "producto_imagenes_update" ON ferretodo.producto_imagenes
        FOR UPDATE USING (public.puede_acceder_empresa(empresa_id))
        WITH CHECK (public.puede_acceder_empresa(empresa_id));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='ferretodo' AND tablename='producto_imagenes' AND policyname='producto_imagenes_delete') THEN
      CREATE POLICY "producto_imagenes_delete" ON ferretodo.producto_imagenes
        FOR DELETE USING (public.puede_acceder_empresa(empresa_id));
    END IF;

    RAISE NOTICE '[producto_imagenes] RLS habilitada con public.puede_acceder_empresa.';
  ELSE
    RAISE NOTICE '[producto_imagenes] Helper public.puede_acceder_empresa no existe: se omite RLS (aislamiento por app + empresa_id, igual que devoluciones_venta).';
  END IF;
END $$;

-- ── 5) Backfill: la imagen legacy de cada producto pasa a ser su principal ──────
-- Migra productos.imagen_path (+ imagen_url si existia) como fila principal,
-- solo si el producto todavia no tiene ninguna imagen en la galeria. No borra
-- ni modifica la columna legacy: sigue viva para compatibilidad.
INSERT INTO ferretodo.producto_imagenes (empresa_id, producto_id, storage_path, url, orden, es_principal)
SELECT p.empresa_id, p.id, p.imagen_path, p.imagen_url, 0, true
  FROM ferretodo.productos p
 WHERE p.imagen_path IS NOT NULL
   AND btrim(p.imagen_path) <> ''
   AND NOT EXISTS (
     SELECT 1 FROM ferretodo.producto_imagenes pi
      WHERE pi.producto_id = p.id AND pi.empresa_id = p.empresa_id
   );
