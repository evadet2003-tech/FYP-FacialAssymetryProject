/** Resize and re-encode as JPEG so history fits in localStorage (PNG data URLs are often 5–20MB). */

export function compressDataUrlForStorage(
  dataUrl: string,
  options?: { maxEdge?: number; quality?: number },
): Promise<string> {
  const maxEdge = options?.maxEdge ?? 720;
  const quality = options?.quality ?? 0.76;

  return new Promise((resolve) => {
    if (!dataUrl.startsWith("data:image") || typeof document === "undefined") {
      resolve(dataUrl);
      return;
    }

    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w < 1 || h < 1) {
        resolve(dataUrl);
        return;
      }
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export function isQuotaExceededError(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "QuotaExceededError" || (e as DOMException).code === 22);
}
