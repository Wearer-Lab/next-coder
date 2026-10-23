const PRIVATE_MEDIA_QUEUE_URL = "http://background.internal/v1/media/process";
const MAX_DELAY_SECONDS = 900;

/** A private Container outbound capability. Durable jobs remain the source of truth. */
export function createCloudMediaQueuePublisher({ url = null, fetchImpl = globalThis.fetch, logger = console, timeoutMs = 2000 } = {}) {
  if (!url) return async () => false;
  if (url !== PRIVATE_MEDIA_QUEUE_URL) throw new Error("Cloud media queue must use its private capability endpoint.");
  const budgetMs = Math.max(1, Math.min(2000, Number(timeoutMs) || 2000));
  return async ({ jobId, delaySeconds = 0 } = {}) => {
    if (typeof jobId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/u.test(jobId)) return false;
    const delay = Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.ceil(Number(delaySeconds) || 0)));
    const controller = new AbortController();
    let timer;
    try {
      const response = await Promise.race([
        fetchImpl(url, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId, delaySeconds: delay }),
        }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("queue deadline")); }, budgetMs); }),
      ]);
      void response.body?.cancel?.().catch(() => {});
      if (response.status !== 202) throw new Error("queue rejected");
      return true;
    } catch {
      // Neither credentials, media, transcripts nor upstream diagnostics belong in this log.
      logger.warn?.("Cloud media scheduling unavailable; durable work awaits the recovery scheduler.");
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
