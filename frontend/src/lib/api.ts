export class ApiError extends Error {
  status?: number;
  isTimeout: boolean;
  latencyMs?: number;

  constructor(message: string, opts: { status?: number; isTimeout?: boolean; latencyMs?: number } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.isTimeout = Boolean(opts.isTimeout);
    this.latencyMs = opts.latencyMs;
  }
}

type ApiCallOptions = RequestInit & {
  timeoutMs?: number;
};

function parseResponse(raw: string) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

export function normalizeApiError(error: unknown, fallback = "Unbekannter Fehler") {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

export async function apiCall<T>(url: string, options: ApiCallOptions = {}): Promise<{ data: T; latencyMs: number; status: number }> {
  const { timeoutMs = 15000, ...requestOptions } = options;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const resp = await fetch(url, {
      ...requestOptions,
      signal: requestOptions.signal || controller.signal
    });
    const raw = await resp.text();
    const body: any = parseResponse(raw);
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));

    if (!resp.ok) {
      throw new ApiError(body.detail || body.error || body.raw || `HTTP ${resp.status}`, {
        status: resp.status,
        latencyMs
      });
    }

    return {
      data: body as T,
      latencyMs,
      status: resp.status
    };
  } catch (error: any) {
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    if (error?.name === "AbortError") {
      throw new ApiError("Zeitüberschreitung der Anfrage. Bitte erneut versuchen.", { isTimeout: true, latencyMs });
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(error?.message || "Netzwerkfehler", { latencyMs });
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const { data } = await apiCall<T>(url, options);
  return data;
}

export function uploadWithProgress(
  baseUrl: string,
  file: File,
  onProgress: (loaded: number, total: number) => void
) {
  return new Promise<any>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${baseUrl}/documents/upload`);
    xhr.timeout = 180000;

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(event.loaded, event.total);
    };

    xhr.onerror = () => reject(new ApiError("Netzwerkfehler beim Upload."));
    xhr.ontimeout = () => reject(new ApiError("Upload hat zu lange gedauert. Bitte erneut versuchen.", { isTimeout: true }));
    xhr.onload = () => {
      let data: any = {};
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        // ignore
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError(data.detail || `HTTP ${xhr.status}`, { status: xhr.status }));
        return;
      }
      resolve(data);
    };

    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
