/**
 * Util generico para exportar a Excel (.xlsx) con formato de tabla.
 *
 * Todas las exportaciones del ERP pasan por acá, así que el diseño se define
 * una sola vez: encabezado con el color de marca, filas alternadas, bordes
 * suaves, anchos automáticos y AUTOFILTRO (los desplegables
 * de filtro/orden en cada columna, que es lo que se usa para armar tablas
 * dinámicas sobre el export).
 *
 * Usa `xlsx-js-style` (fork de SheetJS con soporte de estilos de celda; la
 * versión community de `xlsx` ignora los estilos).
 *
 * No depende de Campañas — NO se debe tocar
 * src/lib/campaigns/campaign-import-service.ts.
 */
import * as XLSX from "xlsx-js-style";

// ── Paleta (alineada con la UI del ERP) ──────────────────────────────────────
const MARCA = "4FAEB2";      // teal de marca (encabezado)
const TEXTO = "1F2937";      // slate-800
const CEBRA = "F1F7F8";      // fila alterna (teal muy suave)
const BORDE = "D8E3E5";      // borde suave

const BORDE_FINO = {
  top:    { style: "thin", color: { rgb: BORDE } },
  bottom: { style: "thin", color: { rgb: BORDE } },
  left:   { style: "thin", color: { rgb: BORDE } },
  right:  { style: "thin", color: { rgb: BORDE } },
} as const;

/** Formato de miles para números (sin decimales forzados). */
const FMT_NUM = "#,##0.###";
const FMT_FECHA = "dd/mm/yyyy";

export interface ExportColumn<T> {
  header: string;
  /** Funcion para extraer el valor de la fila (string | number | null | undefined | boolean | Date). */
  value: (row: T) => string | number | boolean | null | undefined | Date;
  /** Ancho aproximado en caracteres (opcional; si falta se calcula del contenido). */
  width?: number;
}

export interface ExportOptions {
  /** Nombre de la hoja dentro del libro. Por defecto "Datos". */
  sheetName?: string;
  /** Nombre del archivo sugerido (sin extension). */
  filename?: string;
}

type Celda = string | number | boolean | Date;

/** Ancho automático: el más largo entre encabezado y contenido, acotado. */
function anchosAuto(aoa: Celda[][], explicitos?: (number | undefined)[]): { wch: number }[] {
  const cols = aoa[0]?.length ?? 0;
  const out: { wch: number }[] = [];
  for (let c = 0; c < cols; c++) {
    const fijo = explicitos?.[c];
    if (fijo) { out.push({ wch: fijo }); continue; }
    let max = 10;
    for (const fila of aoa) {
      const v = fila[c];
      const len = v instanceof Date ? 10 : String(v ?? "").length;
      if (len > max) max = len;
    }
    out.push({ wch: Math.min(Math.max(max + 2, 10), 48) });
  }
  return out;
}

/** Aplica encabezado de marca, cebra, bordes, autofiltro y panel congelado. */
function aplicarEstilo(ws: XLSX.WorkSheet, filas: number, cols: number): void {
  for (let r = 0; r < filas; r++) {
    for (let c = 0; c < cols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;

      if (r === 0) {
        // Encabezado
        cell.s = {
          font: { bold: true, sz: 11, color: { rgb: "FFFFFF" } },
          fill: { patternType: "solid", fgColor: { rgb: MARCA } },
          alignment: { horizontal: "left", vertical: "center", wrapText: true },
          border: BORDE_FINO,
        };
        continue;
      }

      const esNum = typeof cell.v === "number";
      const esFecha = cell.t === "d" || cell.v instanceof Date;
      cell.s = {
        font: { sz: 10.5, color: { rgb: TEXTO } },
        fill: r % 2 === 0
          ? { patternType: "solid", fgColor: { rgb: CEBRA } }
          : { patternType: "solid", fgColor: { rgb: "FFFFFF" } },
        alignment: {
          horizontal: esNum ? "right" : esFecha ? "center" : "left",
          vertical: "center",
          wrapText: false,
        },
        border: BORDE_FINO,
        numFmt: esNum ? FMT_NUM : esFecha ? FMT_FECHA : undefined,
      };
    }
  }

  // Alto del encabezado + autofiltro en todo el rango.
  ws["!rows"] = [{ hpt: 22 }];
  if (filas > 0 && cols > 0) {
    ws["!autofilter"] = {
      ref: `${XLSX.utils.encode_cell({ r: 0, c: 0 })}:${XLSX.utils.encode_cell({ r: filas - 1, c: cols - 1 })}`,
    };
  }
  // Nota: congelar la primera fila NO se aplica — el writer de SheetJS community
  // no serializa paneles congelados. El autofiltro sí, que es lo importante acá.
}

function celdasDeFilas<T>(rows: T[], columns: ExportColumn<T>[]): Celda[][] {
  return rows.map((row) =>
    columns.map((c) => {
      const v = c.value(row);
      if (v == null) return "";
      return v as Celda;
    })
  );
}

export function buildXlsxBuffer<T>(
  rows: T[],
  columns: ExportColumn<T>[],
  opts: ExportOptions = {}
): Buffer {
  const sheetName = (opts.sheetName ?? "Datos").slice(0, 31); // limite Excel
  const headerRow = columns.map((c) => c.header);
  const dataRows = celdasDeFilas(rows, columns);
  const aoa: Celda[][] = [headerRow, ...dataRows];

  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  ws["!cols"] = anchosAuto(aoa, columns.map((c) => c.width));
  aplicarEstilo(ws, aoa.length, columns.length);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true }) as Buffer;
}

/** Spec de una hoja ya materializada (header + filas como matriz). */
export interface XlsxSheetSpec {
  sheetName: string;
  aoa: (string | number | boolean | Date)[][];
  colWidths?: number[];
}

/** Convierte filas tipadas + columnas en una hoja (header incluido). */
export function sheetFromRows<T>(
  sheetName: string,
  rows: T[],
  columns: ExportColumn<T>[]
): XlsxSheetSpec {
  const header = columns.map((c) => c.header);
  const data = celdasDeFilas(rows, columns);
  return {
    sheetName: sheetName.slice(0, 31),
    aoa: [header, ...data],
    colWidths: columns.map((c) => c.width ?? 16),
  };
}

/** Construye un workbook con varias hojas (mismo diseño) y devuelve el Buffer. */
export function buildXlsxBufferSheets(sheets: XlsxSheetSpec[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa, { cellDates: true });
    ws["!cols"] = anchosAuto(s.aoa as Celda[][], s.colWidths);
    aplicarEstilo(ws, s.aoa.length, s.aoa[0]?.length ?? 0);
    XLSX.utils.book_append_sheet(wb, ws, s.sheetName.slice(0, 31));
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true }) as Buffer;
}

export function xlsxResponseHeaders(filename: string): HeadersInit {
  const safe = filename.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return {
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${safe}.xlsx"`,
    "Cache-Control": "no-store",
  };
}

/** Helper: yyyy-mm-dd-HHMM para sufijos de nombre de archivo. */
export function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
