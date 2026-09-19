-- =============================================================================
-- Ferretodo: alta/vinculación de Alex Ramirez y Lucas Meza
-- Accesos solicitados:
--   - Ventas / Caja      -> modulo slug: ventas
--   - Carga de stock     -> modulo slug: inventario
--   - Cobranzas          -> modulo slug: pagos
--
-- Nota: en Ferretodo "Caja" y "Ventas" comparten el mismo permiso `ventas`.
-- La pantalla legacy /cobros redirige a /pagos, por eso Cobranzas usa `pagos`.
--
-- Idempotente: puede ejecutarse más de una vez.
-- =============================================================================

DO $$
DECLARE
  v_empresa_id uuid;
  v_alex_usuario_id uuid;
  v_lucas_usuario_id uuid;
BEGIN
  SELECT e.id
    INTO v_empresa_id
  FROM ferretodo.empresas e
  WHERE lower(trim(e.nombre)) = 'ferretodo'
  ORDER BY e.created_at ASC NULLS LAST
  LIMIT 1;

  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'No se encontró la empresa Ferretodo en ferretodo.empresas';
  END IF;

  -- Asegurar que los módulos requeridos estén habilitados para Ferretodo.
  INSERT INTO ferretodo.empresa_modulos (empresa_id, modulo_id, activo)
  SELECT v_empresa_id, m.id, true
  FROM ferretodo.modulos m
  WHERE m.slug IN ('ventas', 'inventario', 'pagos')
  ON CONFLICT (empresa_id, modulo_id)
  DO UPDATE SET activo = true;

  -- ---------------------------------------------------------------------------
  -- Alex Ramirez
  -- Auth user: 03a8c8de-aace-4185-9455-05fb2baf0ab0
  -- ---------------------------------------------------------------------------
  UPDATE ferretodo.usuarios
  SET
    empresa_id = v_empresa_id,
    email = 'alexramirez@ferretodo.com',
    nombre = 'Alex Ramirez',
    rol = 'usuario',
    auth_user_id = '03a8c8de-aace-4185-9455-05fb2baf0ab0'::uuid,
    estado = 'activo',
    updated_at = now()
  WHERE lower(trim(email)) = 'alexramirez@ferretodo.com'
     OR auth_user_id = '03a8c8de-aace-4185-9455-05fb2baf0ab0'::uuid
  RETURNING id INTO v_alex_usuario_id;

  IF v_alex_usuario_id IS NULL THEN
    INSERT INTO ferretodo.usuarios (
      empresa_id,
      email,
      nombre,
      rol,
      auth_user_id,
      estado
    )
    VALUES (
      v_empresa_id,
      'alexramirez@ferretodo.com',
      'Alex Ramirez',
      'usuario',
      '03a8c8de-aace-4185-9455-05fb2baf0ab0'::uuid,
      'activo'
    )
    RETURNING id INTO v_alex_usuario_id;
  END IF;

  DELETE FROM ferretodo.usuario_modulos
  WHERE usuario_id = v_alex_usuario_id;

  INSERT INTO ferretodo.usuario_modulos (usuario_id, modulo_id)
  SELECT v_alex_usuario_id, m.id
  FROM ferretodo.modulos m
  JOIN ferretodo.empresa_modulos em
    ON em.empresa_id = v_empresa_id
   AND em.modulo_id = m.id
   AND em.activo IS TRUE
  WHERE m.slug IN ('ventas', 'inventario', 'pagos')
  ON CONFLICT (usuario_id, modulo_id) DO NOTHING;

  -- ---------------------------------------------------------------------------
  -- Lucas Meza
  -- Auth user: eb9d0cff-d3fa-4891-b55e-ac158c2cc4d3
  -- ---------------------------------------------------------------------------
  UPDATE ferretodo.usuarios
  SET
    empresa_id = v_empresa_id,
    email = 'lucasmeza@ferretodo.com',
    nombre = 'Lucas Meza',
    rol = 'usuario',
    auth_user_id = 'eb9d0cff-d3fa-4891-b55e-ac158c2cc4d3'::uuid,
    estado = 'activo',
    updated_at = now()
  WHERE lower(trim(email)) = 'lucasmeza@ferretodo.com'
     OR auth_user_id = 'eb9d0cff-d3fa-4891-b55e-ac158c2cc4d3'::uuid
  RETURNING id INTO v_lucas_usuario_id;

  IF v_lucas_usuario_id IS NULL THEN
    INSERT INTO ferretodo.usuarios (
      empresa_id,
      email,
      nombre,
      rol,
      auth_user_id,
      estado
    )
    VALUES (
      v_empresa_id,
      'lucasmeza@ferretodo.com',
      'Lucas Meza',
      'usuario',
      'eb9d0cff-d3fa-4891-b55e-ac158c2cc4d3'::uuid,
      'activo'
    )
    RETURNING id INTO v_lucas_usuario_id;
  END IF;

  DELETE FROM ferretodo.usuario_modulos
  WHERE usuario_id = v_lucas_usuario_id;

  INSERT INTO ferretodo.usuario_modulos (usuario_id, modulo_id)
  SELECT v_lucas_usuario_id, m.id
  FROM ferretodo.modulos m
  JOIN ferretodo.empresa_modulos em
    ON em.empresa_id = v_empresa_id
   AND em.modulo_id = m.id
   AND em.activo IS TRUE
  WHERE m.slug IN ('ventas', 'inventario', 'pagos')
  ON CONFLICT (usuario_id, modulo_id) DO NOTHING;

  IF (
    SELECT count(*)
    FROM ferretodo.usuario_modulos um
    JOIN ferretodo.modulos m ON m.id = um.modulo_id
    WHERE um.usuario_id = v_alex_usuario_id
      AND m.slug IN ('ventas', 'inventario', 'pagos')
  ) <> 3 THEN
    RAISE EXCEPTION 'No se pudieron asignar los 3 módulos requeridos a Alex Ramirez';
  END IF;

  IF (
    SELECT count(*)
    FROM ferretodo.usuario_modulos um
    JOIN ferretodo.modulos m ON m.id = um.modulo_id
    WHERE um.usuario_id = v_lucas_usuario_id
      AND m.slug IN ('ventas', 'inventario', 'pagos')
  ) <> 3 THEN
    RAISE EXCEPTION 'No se pudieron asignar los 3 módulos requeridos a Lucas Meza';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
