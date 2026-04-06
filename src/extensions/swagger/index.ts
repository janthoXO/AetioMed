import { z } from 'zod'
import { defineExtension } from '../../core/extension.js'
import { extension as coreExtension } from '../core/index.js'
import swaggerRouter from './router.js'

export const extension = defineExtension({
  name: 'swagger',
  requiredFlags: [], // Doesn't seem to have a flag requirement; can add if needed
  dependsOn: [coreExtension] as const,
  envSchema: z.object({}),
  async setup({ router }) {
    console.log('[swagger] Initializing Swagger UI...')
    router.use('/', swaggerRouter)
  }
})
