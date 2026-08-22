-- =============================================================================
-- FERRETODO — SETUP COMPLETO (un solo script)
-- =============================================================================
-- 1) Crea el schema `ferretodo` clonando la ESTRUCTURA de `ferrecolor` (sin datos)
-- 2) Siembra el catálogo de `modulos` (definiciones del sistema, mismos ids)
-- 3) Crea la empresa Ferretodo (plantilla = Ferrecolor, fiscal en blanco, id nuevo)
-- 4) Habilita los mismos módulos y deja facturación en 'sin_factura_fiscal'
--
-- OJO: el catálogo (empresas/usuarios/modulos/empresa_modulos) vive DENTRO de
-- cada schema tenant, no en un schema global.
--
-- NO copia productos, clientes, ventas, compras ni ningún dato del negocio.
-- Transaccional: si algo falla, revierte todo. Aborta si `ferretodo` ya existe.
-- =============================================================================

BEGIN;

DO $FERRETODO$
DECLARE
  v_src      text := 'ferrecolor';
  v_tgt      text := 'ferretodo';
  v_emp_src  uuid := '33eb907d-7df3-4e1f-8fe9-20965c6f05ed';  -- empresa Ferrecolor (plantilla)
  v_emp_new  uuid;
  r RECORD; v_def text; v_seq text; v_col text; v_tbl text; v_n int; v_ok boolean;
BEGIN
  -- ══ 0) Guardas ═════════════════════════════════════════════════════════════
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_src) THEN
    RAISE EXCEPTION 'El schema origen % no existe.', v_src;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_tgt) THEN
    RAISE EXCEPTION 'El schema % YA existe. Abortado para no pisar nada.', v_tgt;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.empresas WHERE id = %L)', v_src, v_emp_src) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'No existe la empresa plantilla % en %.empresas.', v_emp_src, v_src;
  END IF;

  -- ══ 1) Schema + grants ═════════════════════════════════════════════════════
  EXECUTE format('CREATE SCHEMA %I', v_tgt);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO postgres, anon, authenticated, service_role', v_tgt);

  -- ══ 2) Tablas (estructura completa; FKs en el paso 4) ══════════════════════
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND c.relkind = 'r' AND c.relpersistence = 'p'
    ORDER BY c.relname
  LOOP
    EXECUTE format('CREATE TABLE %I.%I (LIKE %I.%I INCLUDING ALL)', v_tgt, r.tabla, v_src, r.tabla);
  END LOOP;

  -- ══ 3) Secuencias propias ══════════════════════════════════════════════════
  FOR r IN
    SELECT c.relname AS tabla, a.attname AS columna
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_attrdef  ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    WHERE n.nspname = v_tgt AND c.relkind = 'r'
      AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%' || v_src || '.%'
  LOOP
    v_tbl := r.tabla; v_col := r.columna; v_seq := v_tbl || '_' || v_col || '_seq';
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I.%I', v_tgt, v_seq);
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT nextval(%L)',
                   v_tgt, v_tbl, v_col, format('%I.%I', v_tgt, v_seq));
    EXECUTE format('ALTER SEQUENCE %I.%I OWNED BY %I.%I.%I', v_tgt, v_seq, v_tgt, v_tbl, v_col);
  END LOOP;

  -- ══ 4) FKs: internas reescritas; externas intactas ═════════════════════════
  FOR r IN
    SELECT c.relname AS tabla, con.conname AS nombre, pg_get_constraintdef(con.oid) AS definicion
    FROM pg_constraint con
    JOIN pg_class c     ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND con.contype = 'f'
    ORDER BY c.relname, con.conname
  LOOP
    v_def := replace(r.definicion, format('REFERENCES %I.', v_src), format('REFERENCES %I.', v_tgt));
    v_def := replace(v_def,        format('REFERENCES %s.', v_src), format('REFERENCES %s.', v_tgt));
    BEGIN
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', v_tgt, r.tabla, r.nombre, v_def);
    EXCEPTION WHEN others THEN RAISE NOTICE 'FK omitida %.%: %', r.tabla, r.nombre, SQLERRM;
    END;
  END LOOP;

  -- ══ 5) Funciones ═══════════════════════════════════════════════════════════
  FOR r IN
    SELECT pg_get_functiondef(p.oid) AS definicion FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = v_src AND p.prokind IN ('f','p')
  LOOP
    v_def := replace(replace(r.definicion, format('%I.', v_src), format('%I.', v_tgt)), v_src||'.', v_tgt||'.');
    BEGIN EXECUTE v_def; EXCEPTION WHEN others THEN RAISE NOTICE 'función omitida: %', SQLERRM; END;
  END LOOP;

  -- ══ 6) Vistas ══════════════════════════════════════════════════════════════
  FOR r IN
    SELECT c.relname AS vista, pg_get_viewdef(c.oid, true) AS definicion FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND c.relkind = 'v'
  LOOP
    v_def := replace(r.definicion, v_src||'.', v_tgt||'.');
    BEGIN EXECUTE format('CREATE OR REPLACE VIEW %I.%I AS %s', v_tgt, r.vista, v_def);
    EXCEPTION WHEN others THEN RAISE NOTICE 'vista omitida %: %', r.vista, SQLERRM; END;
  END LOOP;

  -- ══ 7) Triggers ════════════════════════════════════════════════════════════
  FOR r IN
    SELECT c.relname AS tabla, t.tgname AS nombre, pg_get_triggerdef(t.oid) AS definicion
    FROM pg_trigger t
    JOIN pg_class c     ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND NOT t.tgisinternal
  LOOP
    v_def := replace(r.definicion, format('ON %I.%I', v_src, r.tabla), format('ON %I.%I', v_tgt, r.tabla));
    v_def := replace(v_def,        format('ON %s.%s', v_src, r.tabla), format('ON %s.%s', v_tgt, r.tabla));
    v_def := replace(v_def, format('EXECUTE FUNCTION %I.', v_src), format('EXECUTE FUNCTION %I.', v_tgt));
    v_def := replace(v_def, format('EXECUTE FUNCTION %s.', v_src), format('EXECUTE FUNCTION %s.', v_tgt));
    BEGIN EXECUTE v_def; EXCEPTION WHEN others THEN RAISE NOTICE 'trigger omitido %.%: %', r.tabla, r.nombre, SQLERRM; END;
  END LOOP;

  -- ══ 8) RLS + policies ══════════════════════════════════════════════════════
  FOR r IN
    SELECT c.relname AS tabla FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = v_src AND c.relkind = 'r' AND c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_tgt, r.tabla);
  END LOOP;

  FOR r IN
    SELECT tablename AS tabla, policyname AS nombre, permissive, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = v_src
  LOOP
    v_def := format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s',
                    r.nombre, v_tgt, r.tabla,
                    CASE WHEN r.permissive = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                    r.cmd, array_to_string(r.roles, ', '));
    IF r.qual       IS NOT NULL THEN v_def := v_def || format(' USING (%s)',      replace(r.qual,       v_src||'.', v_tgt||'.')); END IF;
    IF r.with_check IS NOT NULL THEN v_def := v_def || format(' WITH CHECK (%s)', replace(r.with_check, v_src||'.', v_tgt||'.')); END IF;
    BEGIN EXECUTE v_def; EXCEPTION WHEN others THEN RAISE NOTICE 'policy omitida %.%: %', r.tabla, r.nombre, SQLERRM; END;
  END LOOP;

  -- ══ 9) Grants + default privileges ═════════════════════════════════════════
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO authenticated', v_tgt);
  EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO postgres, service_role', v_tgt);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO authenticated', v_tgt);
  EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO postgres, service_role', v_tgt);
  EXECUTE format('GRANT EXECUTE ON ALL ROUTINES IN SCHEMA %I TO authenticated, service_role', v_tgt);
  EXECUTE format('GRANT ALL ON ALL ROUTINES IN SCHEMA %I TO postgres, service_role', v_tgt);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated', v_tgt);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT ALL ON TABLES TO postgres, service_role', v_tgt);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO authenticated', v_tgt);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT ALL ON SEQUENCES TO postgres, service_role', v_tgt);

  -- ══ 10) Catálogo de módulos (definiciones del sistema, NO datos del cliente)
  --      Se copian con los MISMOS ids para que empresa_modulos matchee.
  EXECUTE format('INSERT INTO %I.modulos SELECT * FROM %I.modulos ON CONFLICT DO NOTHING', v_tgt, v_src);

  -- ══ 11) Empresa Ferretodo (plantilla Ferrecolor, id nuevo, fiscal en blanco)
  EXECUTE format($SQL$
    INSERT INTO %1$I.empresas
    SELECT (jsonb_populate_record(
              NULL::%1$I.empresas,
              to_jsonb(e) || jsonb_build_object(
                'id',          gen_random_uuid(),
                'nombre',      'Ferretodo',
                'data_schema', %1$L,
                'slug',        %1$L,
                'created_at',  now(),
                'updated_at',  now(),
                'ruc',          NULL, 'razon_social', NULL, 'timbrado', NULL,
                'direccion',    NULL, 'telefono',     NULL, 'email',    NULL,
                'logo_url',     NULL
              ))).*
    FROM %2$I.empresas e
    WHERE e.id = %3$L
    RETURNING id
  $SQL$, v_tgt, v_src, v_emp_src) INTO v_emp_new;

  IF v_emp_new IS NULL THEN
    RAISE EXCEPTION 'No se pudo crear la empresa Ferretodo.';
  END IF;

  -- ══ 12) Módulos habilitados: los mismos que Ferrecolor ════════════════════
  EXECUTE format($SQL$
    INSERT INTO %1$I.empresa_modulos (empresa_id, modulo_id)
    SELECT %2$L::uuid, em.modulo_id
    FROM %3$I.empresa_modulos em
    WHERE em.empresa_id = %4$L
    ON CONFLICT DO NOTHING
  $SQL$, v_tgt, v_emp_new, v_src, v_emp_src);

  -- ══ 13) Vistas de dashboard (config de la empresa, si la tabla existe) ════
  BEGIN
    EXECUTE format($SQL$
      INSERT INTO %1$I.empresa_dashboard_views
      SELECT (jsonb_populate_record(NULL::%1$I.empresa_dashboard_views,
                to_jsonb(v) || jsonb_build_object('id', gen_random_uuid(), 'empresa_id', %2$L))).*
      FROM %3$I.empresa_dashboard_views v
      WHERE v.empresa_id = %4$L
    $SQL$, v_tgt, v_emp_new, v_src, v_emp_src);
  EXCEPTION WHEN others THEN RAISE NOTICE 'dashboard_views omitido: %', SQLERRM;
  END;

  -- ══ 14) Modo de facturación: seguro hasta cargar SIFEN propio ═════════════
  BEGIN
    EXECUTE format(
      'INSERT INTO %I.empresa_facturacion_modo (empresa_id, modo) VALUES (%L, %L) ON CONFLICT (empresa_id) DO NOTHING',
      v_tgt, v_emp_new, 'sin_factura_fiscal');
  EXCEPTION WHEN others THEN RAISE NOTICE 'facturacion_modo omitido: %', SQLERRM;
  END;

  EXECUTE format('SELECT count(*) FROM %I.empresa_modulos WHERE empresa_id = %L', v_tgt, v_emp_new) INTO v_n;

  RAISE NOTICE '=========================================================';
  RAISE NOTICE ' FERRETODO LISTO';
  RAISE NOTICE ' empresa_id : %', v_emp_new;
  RAISE NOTICE ' schema     : %', v_tgt;
  RAISE NOTICE ' modulos    : %', v_n;
  RAISE NOTICE '=========================================================';
END
$FERRETODO$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =============================================================================
-- VERIFICACIÓN
-- =============================================================================

-- 1) empresa_id de Ferretodo (GUARDALO)
SELECT id AS empresa_id_ferretodo, nombre, data_schema FROM ferretodo.empresas;

-- 2) Estructura idéntica (deben coincidir)
SELECT
  (SELECT count(*) FROM information_schema.tables  WHERE table_schema='ferrecolor' AND table_type='BASE TABLE') AS tablas_ferrecolor,
  (SELECT count(*) FROM information_schema.tables  WHERE table_schema='ferretodo'  AND table_type='BASE TABLE') AS tablas_ferretodo,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='ferrecolor') AS cols_ferrecolor,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='ferretodo')  AS cols_ferretodo;

-- 3) Catálogo sembrado (>0) y negocio vacío (=0)
SELECT (SELECT count(*) FROM ferretodo.modulos)         AS modulos_catalogo,
       (SELECT count(*) FROM ferretodo.empresas)        AS empresas,
       (SELECT count(*) FROM ferretodo.empresa_modulos) AS modulos_habilitados,
       (SELECT count(*) FROM ferretodo.productos)       AS productos,
       (SELECT count(*) FROM ferretodo.clientes)        AS clientes,
       (SELECT count(*) FROM ferretodo.ventas)          AS ventas,
       (SELECT count(*) FROM ferretodo.compras)         AS compras,
       (SELECT count(*) FROM ferretodo.usuarios)        AS usuarios;

-- 4) Sin fugas hacia ferrecolor (0 filas)
SELECT c.relname AS tabla, con.conname AS fk
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='ferretodo' AND con.contype='f'
  AND pg_get_constraintdef(con.oid) ILIKE '%ferrecolor%';


-- =============================================================================
-- USUARIOS — después de crearlos en Supabase → Authentication → Users
-- =============================================================================
-- INSERT INTO ferretodo.usuarios (id, empresa_id, email, nombre, rol, activo)
-- VALUES ('<AUTH_USER_UUID>'::uuid, '<EMPRESA_ID_FERRETODO>'::uuid,
--         'admin@ferretodo.com.py', 'Admin Ferretodo', 'admin', true)
-- ON CONFLICT (id) DO UPDATE
--   SET empresa_id = EXCLUDED.empresa_id, rol = EXCLUDED.rol, activo = true;
--
-- INSERT INTO ferretodo.usuario_modulos (usuario_id, modulo_id)
-- SELECT '<AUTH_USER_UUID>'::uuid, em.modulo_id
-- FROM ferretodo.empresa_modulos em
-- WHERE em.empresa_id = '<EMPRESA_ID_FERRETODO>'::uuid
-- ON CONFLICT DO NOTHING;
