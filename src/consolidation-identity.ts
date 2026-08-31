/** Stable identities shared by consolidation storage, RPC, workers, and catalogs. */

export const REVIEW_ID_PATTERN = /^review-[a-f0-9]{64}$/u
const WORKER_SESSION_ID_PATTERN = /^session-memory-review-[a-f0-9]{64}-attempt-[1-9][0-9]*$/u

export function isConsolidationReviewId(value: unknown): value is string {
  return typeof value === 'string' && REVIEW_ID_PATTERN.test(value)
}

export function workerSessionIdOf(reviewId: string, attempt: number): string {
  const suffix = reviewId.startsWith('review-') ? reviewId.slice('review-'.length) : reviewId
  return `session-memory-review-${suffix}-attempt-${attempt}`
}

/** Identify internal audit Sessions so they are never offered as source evidence. */
export function isConsolidationWorkerSessionId(sessionId: string): boolean {
  return WORKER_SESSION_ID_PATTERN.test(sessionId)
}
