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
-- SEGURIDAD: esta galeria se opera EXCLUSIVAMENTE desde APIs server-side que
-- usan service_role (el unico rol con rolbypassrls). Por lo tanto:
--   - RLS se habilita SIEMPRE (sin policies => deny-by-default para cualquier
--     rol que NO bypassee RLS, es decir anon y authenticated).
--   - Solo service_role recibe CRUD; a anon/authenticated se les revoca todo.
--   - NO se depende de public.puede_acceder_empresa() ni se crean policies para
--     anon/authenticated: el aislamiento por empresa lo hace la app (filtro
--     empresa_id en cada endpoint) sobre el acceso de service_role.
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

-- ── 3) Seguridad: RLS SIEMPRE + acceso EXCLUSIVO de service_role ────────────
-- Sin policies: con RLS habilitada, todo rol que no bypassee RLS (anon,
-- authenticated) queda DENEGADO por defecto. service_role bypassea RLS y es el
-- unico que usan los endpoints server-side de esta feature.
ALTER TABLE ferretodo.producto_imagenes ENABLE ROW LEVEL SECURITY;

-- Revocar cualquier privilegio directo de anon/authenticated (incluye los que
-- otorgan las ALTER DEFAULT PRIVILEGES de Supabase sobre tablas nuevas).
REVOKE ALL PRIVILEGES ON TABLE ferretodo.producto_imagenes FROM anon, authenticated;

-- Solo service_role opera la tabla (via APIs server-side autenticadas).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ferretodo.producto_imagenes TO service_role;

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
