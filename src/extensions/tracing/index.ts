import { z } from 'zod'
import { defineExtension } from '../../core/extension.js'
import { extension as coreExtension } from '../core/index.js'
import { getTraceBus, setupTracing } from './traceManager.js'
import { getRequestContext } from '../core/utils/context.js'
import traceRouter from './router.js'

export { setupTracing, getTraceBus }

export const extension = defineExtension({
  name: 'tracing',
  requiredFlags: ['TRACING'],
  dependsOn: [coreExtension] as const,
  envSchema: z.object({}),
  async setup({ bus, router }) {
    console.log('[tracing] Initializing Tracing extension...')

    bus.on('Generation Log', async ({ msg, logLevel }) => {
      const context = getRequestContext();
      const traceId = context?.traceId;
      if (!traceId) return;

      const traceBus = getTraceBus(traceId);
      if (traceBus) {
        traceBus.emit("trace", {
          message: msg,
          category: logLevel,
        });
      }
    });

    bus.on('Generation Failure', async ({ error }) => {
      const context = getRequestContext();
      const traceId = context?.traceId;
      if (!traceId) return;

      const msg = error instanceof Error ? error.message : String(error);

      const traceBus = getTraceBus(traceId);
      if (traceBus) {
        traceBus.emit("trace", {
          message: msg,
          category: "error",
          data: error,
        });
      }
    });

    router.use('/', traceRouter);
  }
})
