-- =============================================================================
-- Ferretodo: módulos/permisos PROPIOS para "Otros ingresos" y "Entidades
-- bancarias".
--
-- Antes estos accesos heredaban del permiso `ventas` (y en un intento previo se
-- gatearon con `configuracion`). Ahora tienen su propio permiso semántico:
--   - otros_ingresos       -> pantalla /otros-ingresos
--   - entidades_bancarias  -> /configuracion/entidades-bancarias
--
-- Se habilitan para toda empresa que ya use módulos, de modo que los admin
-- (que reciben TODOS los empresa_modulos) sigan viéndolos. Los usuarios acotados
-- (rol 'usuario' con usuario_modulos explícito) NO reciben estos módulos, así que
-- con el modo estricto quedan ocultos y bloqueados por URL.
--
-- ADITIVA E IDEMPOTENTE. No toca usuarios ni sus grants. `modulos.slug` no tiene
-- índice único, por eso se usa WHERE NOT EXISTS en vez de ON CONFLICT.
-- =============================================================================

-- 1) Alta en el catálogo de módulos.
INSERT INTO ferretodo.modulos (nombre, slug)
SELECT 'Otros ingresos', 'otros_ingresos'
WHERE NOT EXISTS (SELECT 1 FROM ferretodo.modulos WHERE slug = 'otros_ingresos');

INSERT INTO ferretodo.modulos (nombre, slug)
SELECT 'Entidades bancarias', 'entidades_bancarias'
WHERE NOT EXISTS (SELECT 1 FROM ferretodo.modulos WHERE slug = 'entidades_bancarias');

-- 2) Habilitar los 2 módulos para toda empresa que ya tenga módulos activos.
--    (Preserva el acceso de administradores; los usuarios acotados no los tienen
--     en usuario_modulos y por lo tanto no los ven.)
INSERT INTO ferretodo.empresa_modulos (empresa_id, modulo_id, activo)
SELECT DISTINCT em.empresa_id, m.id, true
  FROM ferretodo.empresa_modulos em
  JOIN ferretodo.modulos m ON m.slug IN ('otros_ingresos', 'entidades_bancarias')
 WHERE NOT EXISTS (
   SELECT 1 FROM ferretodo.empresa_modulos e2
    WHERE e2.empresa_id = em.empresa_id AND e2.modulo_id = m.id
 );
