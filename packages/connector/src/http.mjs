import { safeError } from "./redact.mjs";

export async function requestJson(url, {
  fetchImpl = globalThis.fetch,
  method = "GET",
  headers = {},
  body,
  timeoutMs = 10_000,
  expected = null,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new Error(`Request timed out after ${timeoutMs}ms.`);
      timeout.code = "ETIMEDOUT";
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  const accepted = expected ? expected.includes(response.status) : response.ok;
  if (!accepted) {
    const error = new Error(`Next Coder request failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.code = payload?.error?.code ?? payload?.code ?? "HTTP_ERROR";
    error.detail = safeError(error);
    throw error;
  }
  return payload;
}

export function connectorAuthorization(state) {
  return `Connector ${state.connectorId}.${state.secret}`;
}
