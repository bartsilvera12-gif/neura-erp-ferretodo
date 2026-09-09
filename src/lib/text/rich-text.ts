/**
 * Sanitizador de HTML enriquecido para la descripcion/especificaciones de
 * productos.
 *
 * POR QUE PROPIO Y NO UNA LIBRERIA: el set de formato requerido es minimo
 * (negrita, cursiva, subrayado, tachado, titulos, parrafos, listas y saltos de
 * linea) y no necesita atributos. Con una allowlist de etiquetas y CERO
 * atributos permitidos, el resultado es XSS-safe por construccion: no puede
 * sobrevivir ningun `on*=`, `style=`, `href=javascript:`, `src`, `<script>`,
 * `<iframe>`, `<svg onload>`, etc. Evita sumar dependencias al bundle.
 *
 * Se sanitiza SIEMPRE en el servidor antes de persistir, de modo que la columna
 * `productos.descripcion` nunca guarda HTML inseguro. Cualquier consumidor
 * (incluida la web publica, que vive en otro repo) recibe HTML ya saneado.
 *
 * Reglas:
 *   - Etiquetas permitidas: p, br, strong, b, em, i, u, s, h2, h3, h4,
 *     ul, ol, li, blockquote. Todo lo demas se descarta (conservando el texto).
 *   - `div` se mapea a `p` (algunos navegadores generan div al editar).
 *   - Se ELIMINAN por completo (con su contenido) los bloques peligrosos:
 *     script, style, iframe, object, embed, svg, math, noscript, template,
 *     title, textarea.
 *   - Nunca se emiten atributos.
 *   - Las entidades existentes (&amp;, &#39;, ...) se preservan; los `<`, `>`
 *     y `&` sueltos se escapan.
 */

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "blockquote",
]);

/** Etiquetas que se reescriben a otra equivalente permitida. */
const TAG_MAP: Record<string, string> = {
  div: "p",
  strike: "s",
  del: "s",
  ins: "u",
};

/** Etiquetas vacias (sin cierre). */
const VOID_TAGS = new Set(["br"]);

/**
 * Bloques cuyo CONTENIDO tambien debe eliminarse (no solo la etiqueta). Se
 * remueven en bucle hasta estabilizar para cubrir anidamientos ofuscados.
 */
const DANGEROUS_BLOCKS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "noscript",
  "template",
  "title",
  "textarea",
];

function stripComments(input: string): string {
  // Comentarios HTML, incluyendo condicionales de IE y comentarios sin cierre.
  return input.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--[\s\S]*$/g, "");
}

function stripDangerousBlocks(input: string): string {
  let out = input;
  let prev: string;
  do {
    prev = out;
    for (const tag of DANGEROUS_BLOCKS) {
      // Bloque completo <tag ...> ... </tag>
      out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
      // Apertura sin cierre: eliminar hasta el final.
      out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi"), "");
      // Etiquetas sueltas de apertura/cierre autocontenidas o self-closing.
      out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
    }
  } while (out !== prev);
  return out;
}

const ENTITY_RE = /^&(#[0-9]{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;
const TAG_RE = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/;

/**
 * Sanitiza HTML enriquecido a una allowlist estricta sin atributos.
 * Devuelve string (nunca null). Entrada no-string -> "".
 */
export function sanitizeRichTextHtml(input: unknown): string {
  if (typeof input !== "string") return "";
  let src = input;
  src = stripComments(src);
  src = stripDangerousBlocks(src);

  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    if (ch === "<") {
      const m = TAG_RE.exec(src.slice(i));
      if (m) {
        const closing = m[1] === "/";
        let name = m[2].toLowerCase();
        if (name in TAG_MAP) name = TAG_MAP[name];
        if (ALLOWED_TAGS.has(name)) {
          if (VOID_TAGS.has(name)) {
            out += `<${name}>`;
          } else {
            out += closing ? `</${name}>` : `<${name}>`;
          }
        }
        // Etiqueta no permitida -> se descarta (se conserva el contenido interno).
        i += m[0].length;
        continue;
      }
      // No es una etiqueta valida -> escapar el '<'.
      out += "&lt;";
      i += 1;
      continue;
    }

    if (ch === ">") {
      out += "&gt;";
      i += 1;
      continue;
    }

    if (ch === "&") {
      const em = ENTITY_RE.exec(src.slice(i));
      if (em) {
        out += em[0];
        i += em[0].length;
      } else {
        out += "&amp;";
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return collapse(out);
}

/**
 * Limpieza cosmetica final: colapsa parrafos/encabezados vacios que dejan
 * algunos editores (`<p></p>`, `<p><br></p>`) y espacios redundantes al inicio
 * y fin. No altera la seguridad; solo evita basura visual.
 */
function collapse(html: string): string {
  let out = html;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<(p|h2|h3|h4|blockquote|li|ul|ol)>\s*(?:<br>\s*)*<\/\1>/gi, "");
  } while (out !== prev);
  return out.trim();
}

/**
 * true si el contenido no tiene texto visible ni imagenes (solo etiquetas
 * vacias / espacios). Sirve para normalizar a null cuando el editor quedo
 * "vacio" pero dejo `<p></p>`.
 */
export function isEffectivelyEmptyHtml(input: unknown): boolean {
  if (typeof input !== "string") return true;
  const text = input
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, "")
    .trim();
  return text.length === 0;
}

/**
 * Normaliza el valor a persistir en `descripcion`:
 *   - sanitiza,
 *   - si queda vacio -> null,
 *   - recorta a un maximo defensivo de longitud.
 */
const MAX_DESCRIPCION_LEN = 20000;

export function normalizeDescripcionParaGuardar(input: unknown): string | null {
  if (input == null) return null;
  const clean = sanitizeRichTextHtml(input).slice(0, MAX_DESCRIPCION_LEN);
  if (isEffectivelyEmptyHtml(clean)) return null;
  return clean;
}
