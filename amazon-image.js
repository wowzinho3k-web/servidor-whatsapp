import { createHash } from "node:crypto";

const MAX_BYTES = 10 * 1024 * 1024;
const MIN_BYTES = 512;
const MIN_EDGE = 256;
const MIN_LONG_EDGE = 512;
const MAX_PIXELS = 40000000;

function failure(code) {
  const error = new Error("A imagem Amazon não passou na validação.");
  error.amazonImageCode = code;
  return error;
}

export function amazonImageErrorCode(error) {
  const code = String(error?.amazonImageCode || error?.code || "");
  return /^[A-Za-z0-9_-]{1,48}$/.test(code) ? code : "falha_midia";
}

export function amazonImageFailureStage(error) {
  const code = String(error?.amazonImageCode || "");
  if (code.startsWith("download_") || code === "imagem_acima_do_limite" || code === "imagem_muito_pequena") return "download";
  return "preparacao";
}

export function amazonImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    const amazonHost = host === "m.media-amazon.com" ||
      host.endsWith(".media-amazon.com") ||
      host.endsWith(".ssl-images-amazon.com");
    return url.protocol === "https:" && amazonHost && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

async function readImageLimited(response) {
  const contentLength = response.headers?.get?.("content-length");
  const declaredSize = contentLength === null || contentLength === undefined || contentLength === ""
    ? null
    : Number(contentLength);
  if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize <= 0)) {
    throw failure("download_tamanho_invalido");
  }
  if (declaredSize > MAX_BYTES) throw failure("imagem_acima_do_limite");

  let bytes;
  if (response.body && Symbol.asyncIterator in Object(response.body)) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      const block = Buffer.from(chunk);
      size += block.length;
      if (size > MAX_BYTES) throw failure("imagem_acima_do_limite");
      chunks.push(block);
    }
    bytes = Buffer.concat(chunks, size);
  } else {
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw failure("imagem_acima_do_limite");
  }

  if (declaredSize !== null && bytes.length !== declaredSize) throw failure("download_incompleto");
  if (bytes.length < MIN_BYTES) throw failure("imagem_muito_pequena");
  return bytes;
}

export async function prepararImagemAmazon(imageUrl, fetchImpl = fetch, sharpImpl) {
  const allowedUrl = amazonImageUrl(imageUrl);
  if (!allowedUrl) throw failure("url_amazon_nao_permitida");

  if (!sharpImpl) {
    try {
      sharpImpl = (await import("sharp")).default;
    } catch {
      throw failure("sharp_indisponivel");
    }
  }

  let response;
  try {
    response = await fetchImpl(allowedUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "image/jpeg" }
    });
  } catch {
    throw failure("download_falhou");
  }

  if (response.status !== 200 || !response.ok) {
    throw failure(`download_http_${Number(response.status) || 0}`);
  }

  const contentType = String(response.headers?.get?.("content-type") || "")
    .split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "image/jpeg") throw failure("mime_nao_suportado");

  let original;
  try {
    original = await readImageLimited(response);
  } catch (error) {
    if (error?.amazonImageCode) throw error;
    throw failure("download_leitura_falhou");
  }

  try {
    const options = { failOn: "warning", limitInputPixels: MAX_PIXELS };
    const metadata = await sharpImpl(original, options).metadata();
    if (metadata.format !== "jpeg") throw failure("mime_conteudo_divergente");

    const width = Number(metadata.autoOrient?.width || metadata.width);
    const height = Number(metadata.autoOrient?.height || metadata.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < MIN_EDGE || height < MIN_EDGE ||
        Math.max(width, height) < MIN_LONG_EDGE || width * height > MAX_PIXELS) {
      throw failure("resolucao_insuficiente_ou_invalida");
    }

    // stats forces a full decode. The original bytes remain untouched for Baileys.
    await sharpImpl(original, options).stats();
    return {
      buffer: original,
      mimetype: "image/jpeg",
      width,
      height,
      bytes: original.length,
      sha256: createHash("sha256").update(original).digest("hex")
    };
  } catch (error) {
    if (error?.amazonImageCode) throw error;
    throw failure("integridade_imagem_falhou");
  }
}
