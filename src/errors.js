export function serializeError(error) {
  const retryAt = error?.retryAt;
  return {
    kind: error?.kind ?? 'unknown',
    message: String(error?.message ?? error),
    retryAt:
      retryAt instanceof Date && Number.isFinite(retryAt.getTime()) ? retryAt.toISOString() : null,
  };
}
