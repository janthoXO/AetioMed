const controllers = new Map<string, AbortController>();

export function register(jobId: string, controller: AbortController): void {
  controllers.set(jobId, controller);
}

export function unregister(jobId: string): void {
  controllers.delete(jobId);
}

export function abort(jobId: string): boolean {
  const controller = controllers.get(jobId);
  if (!controller) return false;
  controller.abort();
  controllers.delete(jobId);
  return true;
}

export function isActive(jobId: string): boolean {
  return controllers.has(jobId);
}
