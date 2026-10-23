# API REST — Neura ERP

Capa de API para exponer datos del ERP y permitir integraciones externas.

## Autenticación

Todos los endpoints requieren **usuario autenticado** con Supabase. La sesión se obtiene mediante cookies. El sistema es **multiempresa**: cada usuario solo accede a los datos de su empresa.

## Formato de respuesta

### Éxito

```json
{
  "success": true,
  "data": { ... }
}
```

### Error

```json
{
  "success": false,
  "error": "Mensaje de error"
}
```

## Endpoints

### Clientes

#### GET /api/clientes

Lista los clientes de la empresa del usuario autenticado.

**Respuesta:** Array de clientes.

---

#### POST /api/clientes

Crea un nuevo cliente.

**Body (JSON):**

| Campo           | Tipo   | Obligatorio | Descripción                    |
|-----------------|--------|-------------|--------------------------------|
| nombre_contacto | string | Sí          | Nombre del contacto            |
| tipo_cliente    | string | No          | `empresa` o `persona` (default: empresa) |
| empresa         | string | No          | Razón social (si tipo=empresa) |
| ruc             | string | No          | RUC                            |
| documento       | string | No          | CI/Documento (si tipo=persona) |
| telefono        | string | No          | Teléfono                       |
| email           | string | No          | Email                          |
| direccion       | string | No          | Dirección                      |
| ciudad          | string | No          | Ciudad                         |
| pais            | string | No          | País                           |
| condicion_pago  | string | No          | Condición de pago              |
| moneda_preferida| string | No          | `GS` o `USD` (default: GS)     |
| estado          | string | No          | `activo` o `inactivo`          |

---

### Facturas

#### GET /api/facturas

Lista las facturas de la empresa.

**Query params:**

| Param       | Tipo   | Descripción                    |
|-------------|--------|--------------------------------|
| cliente_id  | string | Filtrar por cliente (opcional) |

**Respuesta:** Array de facturas.

---

#### POST /api/facturas

Crea una nueva factura.

**Body (JSON):**

| Campo             | Tipo   | Obligatorio | Descripción                          |
|-------------------|--------|-------------|--------------------------------------|
| cliente_id        | string | Sí          | UUID del cliente                     |
| numero_factura    | string | Sí          | Número correlativo (ej: FAC-000001)  |
| fecha             | string | Sí          | Fecha (YYYY-MM-DD)                   |
| fecha_vencimiento | string | No          | Fecha vencimiento (default: fecha)   |
| monto             | number | Sí          | Monto total (>= 0)                   |
| tipo              | string | No          | `contado`, `credito`, `suscripcion`  |
| moneda            | string | No          | `GS` o `USD` (default: GS)           |

---

#### GET /api/facturas/[id]/notas-credito

Lista las notas de crédito de una factura e indica si se puede crear una nueva (reglas de negocio fase 1).

**Respuesta `data`:** `{ items, puede_crear, motivo_bloqueo_creacion }`.

---

#### POST /api/facturas/[id]/notas-credito

Crea una nota de crédito en estado **borrador** (monto = saldo pendiente; sin envío SIFEN en fase 1).

**Body (JSON):** `motivo` (obligatorio, ≥5 caracteres), `observacion_interna` (opcional).

**Errores típicos:** `409` si aún aplica cancelación del DE, saldo inconsistente, o ya existe NC en curso/aprobada.

---

#### PATCH /api/facturas/[id]/notas-credito/[ncId]

**Body:** `{ "action": "anular_borrador" }` — solo si `estado_erp` es `borrador`.

---

### Notas de crédito — SIFEN (por `nota_credito_id`)

Rutas bajo **`/api/notas-credito/[id]/sifen/...`** donde `[id]` es el UUID de `nota_credito`. Reutilizan certificado, CSC y ambiente de `empresa_sifen_config`. El **impacto en `facturas.saldo`** ocurre solo cuando la consulta de lote determina **aprobación SET** (RPC `nota_credito_tras_aprobacion_set_transaccional`).

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/notas-credito/[id]/sifen/xml` | Genera XML rDE v150 (NC), sube a Storage, estado `generado`. |
| POST | `/api/notas-credito/[id]/sifen/firmar` | Firma el XML (XML-DSig), estado `firmado`. |
| POST | `/api/notas-credito/[id]/sifen/enviar-test` | `recibe-lote` solo si ambiente configuración es **test**. |
| POST | `/api/notas-credito/[id]/sifen/enviar` | `recibe-lote` producción (rechaza si ambiente ≠ producción). |
| POST | `/api/notas-credito/[id]/sifen/consulta-lote-test` | Consulta lote TEST (`dProtConsLote`); puede marcar `en_proceso`, `aprobado` o `rechazado`. |
| POST | `/api/notas-credito/[id]/sifen/consulta-lote` | Igual en producción. |
| POST | `/api/notas-credito/[id]/sifen/procesar-test` | Secuencia: xml → firmar → enviar-test. |
| POST | `/api/notas-credito/[id]/sifen/procesar` | Secuencia: xml → firmar → enviar (prod). |

**Query opcional:** `?debug=1` en xml/firmar incluye el XML en la respuesta; `?debug=1` en enviar incluye SOAP; `?debug=1` en consulta-lote incluye cuerpo SOAP.

**SIFEN test con empresa en producción:** si en el servidor está `ALLOW_TEST_MODE=true` (o `1` / `yes`), los endpoints `*-test` de facturas y NC llaman a **SET TEST** aunque `empresa_sifen_config.ambiente` sea `produccion`. Sin esa variable, los `*-test` siguen exigiendo ambiente `test` en configuración.

---

#### GET /api/config/allow-test-mode

Sesión requerida. Respuesta `data`: `{ allowSifenTestOverride, empresa_sifen_ambiente }` — indica si aplica el override y el ambiente configurado para la empresa.

---

#### GET /api/notas-credito

Listado global de notas de crédito del tenant. Query params opcionales: `desde`, `hasta` (fecha `YYYY-MM-DD`), `cliente_id`, `estado_erp`, `estado_sifen`, `usuario_id`, `factura_id`, `buscar` (motivo), `cdc` (fragmento, ≥8 caracteres), `con_error` (`1` | `0`), `page`, `limit` (máx. 200).

---

#### GET /api/notas-credito/[id]

Detalle de una NC: cabecera, electrónica, cliente, factura y **eventos** de auditoría ordenados del más reciente al más antiguo.

---

### Pagos

#### GET /api/pagos

Lista los pagos de la empresa.

**Query params:**

| Param      | Tipo   | Descripción                    |
|------------|--------|--------------------------------|
| factura_id | string | Filtrar por factura (opcional) |

**Respuesta:** Array de pagos.

---

#### POST /api/pagos

Registra un pago contra una factura.

**Body (JSON):**

| Campo      | Tipo   | Obligatorio | Descripción                                    |
|------------|--------|-------------|------------------------------------------------|
| factura_id | string | Sí          | UUID de la factura                             |
| monto      | number | Sí          | Monto del pago (> 0)                           |
| fecha_pago | string | Sí          | Fecha del pago (YYYY-MM-DD)                    |
| metodo_pago| string | No          | `efectivo`, `transferencia`, `cheque`, `tarjeta`, `otro` |
| referencia | string | No          | Nº de comprobante o referencia                 |

**Nota:** Al registrar un pago, se actualiza automáticamente el saldo y estado de la factura.

---

### Cobranzas de crédito (cuentas por cobrar)

Una venta a crédito genera una cuenta por cobrar (`cuentas_por_cobrar`) y los cobros
(`cobros_clientes`) la van reduciendo. El **total de la cuenta nunca se modifica**: lo que
cambia es el `saldo` y el `estado` (`pendiente` → `parcial` → `pagado`), que se recalculan
siempre como `total - suma de cobros vigentes (no anulados)`.

#### GET /api/cobros/cuentas

Cuentas por cobrar + resumen + historial de cobros. Los cobros anulados se devuelven con
`anulado_at` para mostrarlos en el historial, pero no suman al cobrado.

#### POST /api/cobros

Registra un cobro (total o parcial) contra una cuenta por cobrar.

| Campo                 | Tipo   | Obligatorio | Descripción                                        |
|-----------------------|--------|-------------|----------------------------------------------------|
| cuenta_por_cobrar_id  | string | Sí          | UUID de la cuenta por cobrar                       |
| monto                 | number | Sí          | Monto cobrado (> 0, no puede superar el saldo)     |
| metodo_pago           | string | No          | `efectivo`, `transferencia`, `tarjeta`, `otro`     |
| entidad_bancaria_id   | string | No          | Obligatorio en la UI para transferencia/tarjeta    |
| referencia            | string | No          | Nº de operación / comprobante                      |
| titular               | string | No          | Titular de la cuenta o tarjeta                     |
| fecha_pago            | string | No          | ISO; por defecto, ahora                            |

Si el monto es menor al saldo, la cuenta queda `parcial` con la diferencia pendiente.

#### POST /api/cobros/[id]/anular — solo admin

Anula un cobro mal registrado. Anulación **soft**: el cobro queda en el historial con
`anulado_at` + auditoría (quién y por qué), deja de contar para el saldo, se revierte su
ingreso en caja (anulando el movimiento si la caja sigue abierta, o con un egreso
compensatorio si ya cerró) y se anula el recibo de dinero emitido. Idempotente.

**Body:** `{ motivo?: string }`

#### PATCH /api/cobros/[id] — solo admin

Corrige un cobro mal registrado: anula el original y registra uno nuevo con el monto /
método / fecha correctos sobre la misma cuenta, encadenado por `reemplaza_a_cobro_id`.
Caso típico: se cobró el saldo total cuando el cliente abonó solo una parte.

**Body:** mismos campos que `POST /api/cobros` (sin `cuenta_por_cobrar_id`) + `motivo`.

**Respuesta:** `{ cobro_id, cobro_anulado_id, saldo_nuevo, estado }`.

---

### Suscripciones

#### GET /api/suscripciones

Lista las suscripciones de la empresa.

**Query params:**

| Param      | Tipo   | Descripción                    |
|------------|--------|--------------------------------|
| cliente_id | string | Filtrar por cliente (opcional) |

**Respuesta:** Array de suscripciones.

---

#### POST /api/suscripciones

Crea una nueva suscripción.

**Body (JSON):**

| Campo                    | Tipo    | Obligatorio | Descripción                          |
|--------------------------|---------|-------------|--------------------------------------|
| cliente_id               | string  | Sí          | UUID del cliente                     |
| plan_id                  | string  | No          | UUID del plan (opcional)             |
| precio                   | number  | Sí          | Precio (>= 0)                        |
| moneda                   | string  | No          | `GS` o `USD` (default: GS)           |
| fecha_inicio             | string  | Sí          | Fecha inicio (YYYY-MM-DD)            |
| duracion_meses           | number  | No          | Duración en meses (default: 12)      |
| dia_facturacion          | number  | No          | Día del mes (1-28, default: 1)       |
| dia_vencimiento          | number  | No          | Día de vencimiento (1-31, default: 10) |
| generar_factura_este_mes | boolean | No          | Generar factura este mes             |

---

### Dashboard

#### GET /api/dashboard

Obtiene métricas financieras del mes actual.

**Respuesta:**

```json
{
  "success": true,
  "data": {
    "facturado_mes": 15000000,
    "cobrado_mes": 12000000,
    "pendiente_cobro": 3000000
  }
}
```

| Campo           | Descripción                          |
|-----------------|--------------------------------------|
| facturado_mes   | Total facturado en el mes actual     |
| cobrado_mes     | Total cobrado (pagos) en el mes      |
| pendiente_cobro | Saldo pendiente de todas las facturas|

---

## Códigos de estado HTTP

| Código | Significado                    |
|--------|--------------------------------|
| 200    | OK                             |
| 400    | Bad Request (validación, error de Supabase) |
| 401    | No autenticado                 |
| 404    | Recurso no encontrado          |
| 500    | Error interno del servidor     |

---

## Integraciones futuras

La arquitectura está preparada para:

- **Webhooks:** `src/lib/integrations/webhooks.ts` — placeholder para enviar eventos a URLs externas (n8n, Zapier, etc.)
- **Eventos:** `src/lib/integrations/events.ts` — tipos de eventos: `cliente_creado`, `factura_creada`, `pago_registrado`, `suscripcion_creada`
- **API Keys:** estructura lista para autenticación por API key en el futuro
