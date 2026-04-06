import { z } from 'zod'
import { defineExtension } from '../../core/extension.js'
import type { EventBus } from '../../core/event-bus.js'

// We bring in all the original app logic routers here
import apiRouter from './01rest/index.js'
import type { Case } from './models/Case.js';

declare module '../../core/event-bus.js' {
  interface EventMap {
    'Generation Completed': { case: Case; additionalData?: object }
    'Generation Failure': { error: Error; additionalData?: object }
    'Generation Log': { msg: string; logLevel: 'info' | 'warn' | 'error'; timestamp: string; additionalData?: object }
    // Ensure tracing hooks are available to the core system globally if it uses them directly
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let config: { llm?: any; isAllowLlms?: boolean | undefined } = {};
export let bus: EventBus;

export const extension = defineExtension({
  name: 'core',
  requiredFlags: [],
  envSchema: z.object({
    LLM_PROVIDER: z.enum(['ollama', 'google']).optional(),
    LLM_MODEL: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_URL: z.string().url().optional(),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.7),
    ALLOWED_LLMS: z.string().optional(),
  }).superRefine((data, ctx) => {
    // Determine feature flag directly from process.env, or assume it's part of your FEATURES.
    // For simplicity, if ALLOWED_LLMS is given, it's the dynamic LLM mode.
    const isAllowLlms = process.env.FEATURES?.includes('ALLOW_LLMS');
    if (isAllowLlms) {
      if (!data.ALLOWED_LLMS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ALLOWED_LLMS is required when ALLOW_LLMS is enabled' })
      }
    } else {
      if (!data.LLM_PROVIDER || !data.LLM_MODEL) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'LLM_PROVIDER and LLM_MODEL are required' })
      }
    }
  }).transform(env => {
    const isAllowLlms = process.env.FEATURES?.includes('ALLOW_LLMS');
    
    // Parse allowedLlms like in the original config
    let allowedLlms;
    if (isAllowLlms && env.ALLOWED_LLMS) {
      allowedLlms = env.ALLOWED_LLMS.split(',').reduce((acc, pair) => {
        const [provider, model] = pair.split(':');
        if (provider && model) {
          if (!acc[provider as 'ollama' | 'google']) acc[provider as 'ollama' | 'google'] = [];
          acc[provider as 'ollama' | 'google']!.push(model);
        }
        return acc;
      }, {} as Record<'ollama' | 'google', string[]>);
    }

    return {
      llmProvider: env.LLM_PROVIDER,
      llmModel: env.LLM_MODEL,
      llmApiKey: env.LLM_API_KEY,
      llmUrl: env.LLM_URL,
      llmTemperature: env.LLM_TEMPERATURE,
      allowedLlms,
      isAllowLlms
    }
  }),

  async setup({ config: parsedConfig, router, bus: extensionBus }) {
    bus = extensionBus;
    config = {
      llm: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: parsedConfig.llmProvider as any,
        model: parsedConfig.llmModel,
        apiKey: parsedConfig.llmApiKey,
        url: parsedConfig.llmUrl,
        temperature: parsedConfig.llmTemperature
      },
      isAllowLlms: parsedConfig.isAllowLlms
    };

    // Mount the core REST routes to `/api/` 
    // They are standard express routes
    router.use('/', apiRouter)
    
    console.log(`[core] Starting core extension with ${parsedConfig.isAllowLlms ? 'dynamic LLMs' : parsedConfig.llmProvider + '/' + parsedConfig.llmModel}`)
  },
})
