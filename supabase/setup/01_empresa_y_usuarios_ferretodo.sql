-- =============================================================================
-- Ferretodo — PASO 2: empresa, módulos y usuarios
-- Correr DESPUÉS de 00_clonar_schema_ferretodo.sql
-- =============================================================================
-- Crea la empresa Ferretodo copiando la fila de Ferrecolor como PLANTILLA
-- (hereda las mismas columnas/flags) pero con id, nombre y data_schema propios
-- y con los campos fiscales/identidad NEUTRALIZADOS.
-- =============================================================================

-- ── A) Crear la empresa Ferretodo ────────────────────────────────────────────
-- Devuelve el UUID nuevo: GUARDALO, se usa en todos los pasos siguientes.
BEGIN;

WITH nueva AS (
  SELECT (
    jsonb_populate_record(
      NULL::zentra_erp.empresas,
      to_jsonb(e)
      || jsonb_build_object(
           'id',           gen_random_uuid(),
           'nombre',       'Ferretodo',
           'data_schema',  'ferretodo',
           'created_at',   now(),
           'updated_at',   now(),
           -- Identidad/fiscal en blanco: NADA de Ferrecolor viaja.
           'ruc',              NULL,
           'razon_social',     NULL,
           'timbrado',         NULL,
           'direccion',        NULL,
           'telefono',         NULL,
           'email',            NULL,
           'logo_url',         NULL,
           'slug',             'ferretodo'
         )
    )
  ).*
  FROM zentra_erp.empresas e
  WHERE e.id = '33eb907d-7df3-4e1f-8fe9-20965c6f05ed'   -- empresa Ferrecolor (plantilla)
)
INSERT INTO zentra_erp.empresas
SELECT * FROM nueva
RETURNING id AS empresa_id_ferretodo, nombre, data_schema;

COMMIT;

-- ⚠️ Copiá el `empresa_id_ferretodo` devuelto arriba y usalo abajo.


-- ── B) Módulos habilitados (mismos que Ferrecolor) ───────────────────────────
INSERT INTO zentra_erp.empresa_modulos (empresa_id, modulo_id)
SELECT '<EMPRESA_ID_FERRETODO>'::uuid, em.modulo_id
FROM zentra_erp.empresa_modulos em
WHERE em.empresa_id = '33eb907d-7df3-4e1f-8fe9-20965c6f05ed'
ON CONFLICT DO NOTHING;

-- Verificar que quedaron iguales (los dos números deben coincidir)
SELECT
  (SELECT count(*) FROM zentra_erp.empresa_modulos WHERE empresa_id = '33eb907d-7df3-4e1f-8fe9-20965c6f05ed') AS modulos_ferrecolor,
  (SELECT count(*) FROM zentra_erp.empresa_modulos WHERE empresa_id = '<EMPRESA_ID_FERRETODO>'::uuid)          AS modulos_ferretodo;


-- ── C) Usuarios ──────────────────────────────────────────────────────────────
-- 1) Crear el usuario en Supabase → Authentication → Users (email + password).
-- 2) Copiar su UUID (auth.users.id) y correr esto por cada usuario:

INSERT INTO zentra_erp.usuarios (id, empresa_id, email, nombre, rol, activo)
VALUES (
  '<AUTH_USER_UUID>'::uuid,          -- UUID de auth.users
  '<EMPRESA_ID_FERRETODO>'::uuid,
  'admin@ferretodo.com.py',          -- mismo email que en Auth
  'Admin Ferretodo',
  'admin',                           -- admin | vendedor | cajero ...
  true
)
ON CONFLICT (id) DO UPDATE
  SET empresa_id = EXCLUDED.empresa_id,
      rol        = EXCLUDED.rol,
      activo     = true;

-- 3) Dar acceso a los módulos (mismos que un usuario equivalente de Ferrecolor).
--    Si el rol admin ya ve todo por rol, este paso puede no ser necesario.
INSERT INTO zentra_erp.usuario_modulos (usuario_id, modulo_id)
SELECT '<AUTH_USER_UUID>'::uuid, m.id
FROM zentra_erp.modulos m
JOIN zentra_erp.empresa_modulos em
  ON em.modulo_id = m.id AND em.empresa_id = '<EMPRESA_ID_FERRETODO>'::uuid
ON CONFLICT DO NOTHING;


-- ── D) Modo de facturación ───────────────────────────────────────────────────
-- Arranca SIN factura fiscal (seguro). Cambiar a 'sifen' recién cuando estén
-- cargados el certificado, RUC, timbrado y los datos del emisor.
INSERT INTO ferretodo.empresa_facturacion_modo (empresa_id, modo)
VALUES ('<EMPRESA_ID_FERRETODO>'::uuid, 'sin_factura_fiscal')
ON CONFLICT (empresa_id) DO NOTHING;


-- ── E) Refrescar la API ──────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';


-- ── F) Verificación final ────────────────────────────────────────────────────
SELECT
  e.id, e.nombre, e.data_schema,
  (SELECT count(*) FROM zentra_erp.empresa_modulos WHERE empresa_id = e.id) AS modulos,
  (SELECT count(*) FROM zentra_erp.usuarios        WHERE empresa_id = e.id) AS usuarios,
  (SELECT count(*) FROM information_schema.tables  WHERE table_schema = 'ferretodo' AND table_type='BASE TABLE') AS tablas_schema
FROM zentra_erp.empresas e
WHERE e.data_schema = 'ferretodo';

-- Que NO haya datos de Ferrecolor en el schema nuevo (todo debe dar 0)
SELECT
  (SELECT count(*) FROM ferretodo.productos) AS productos,
  (SELECT count(*) FROM ferretodo.clientes)  AS clientes,
  (SELECT count(*) FROM ferretodo.ventas)    AS ventas,
  (SELECT count(*) FROM ferretodo.compras)   AS compras;
