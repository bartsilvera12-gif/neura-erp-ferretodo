-- ============================================================================
-- Precio Promoción (Ferretodo). 4ta modalidad de precio. ADITIVA E IDEMPOTENTE.
--
-- 1) Nuevo precio comercial "promoción" en productos (NO usa costo_promedio).
--    Es un precio promocional opcional que el vendedor puede elegir al vender,
--    igual que mayorista/distribuidor.
-- 2) ventas_items.tipo_precio admite 'promocion'; se conservan los valores
--    previos (minorista/mayorista/distribuidor/costo) para no romper ventas viejas.
--
-- Se accede por el pool (postgres), igual que compras/transferencias/ajustes.
-- ============================================================================

ALTER TABLE ferretodo.productos
  ADD COLUMN IF NOT EXISTS precio_promocion numeric;

ALTER TABLE ferretodo.ventas_items
  DROP CONSTRAINT IF EXISTS ventas_items_tipo_precio_check;

ALTER TABLE ferretodo.ventas_items
  ADD CONSTRAINT ventas_items_tipo_precio_check
  CHECK (tipo_precio = ANY (ARRAY[
    'minorista'::text,
    'mayorista'::text,
    'distribuidor'::text,
    'promocion'::text,
    'costo'::text
  ]));
