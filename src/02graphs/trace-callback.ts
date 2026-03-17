import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import { emitTrace } from "@/utils/tracing.js";

export class TracingCallbackHandler extends BaseCallbackHandler {
  name = "TracingCallbackHandler";
  private runIdNameMap = new Map<string, string>();

  override async handleChainStart(
    chain: Serialized,
    _inputs: Record<string, any>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, any>,
    runType?: string,
    name?: string
  ): Promise<void> {
    const chainName = name || chain.name || chain.id?.[chain.id?.length - 1] || "unknown";
    if (chainName === "RunnableSequence" || chainName === "RunnableParallel") return;
    
    let message = `Starting chain: ${chainName}`;
    if (metadata?.langgraph_node) {
      const step = metadata?.langgraph_step !== undefined ? ` (step ${metadata.langgraph_step})` : "";
      message = `Starting node: ${metadata.langgraph_node}${step}`;
      this.runIdNameMap.set(runId, `node ${metadata.langgraph_node}`);
    } else {
      this.runIdNameMap.set(runId, `chain ${chainName}`);
    }

    emitTrace(message, { data: { runId, tags, metadata } });
  }

  override async handleChainEnd(
    _outputs: Record<string, any>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: { inputs?: Record<string, any> }
  ): Promise<void> {
    const name = this.runIdNameMap.get(runId);
    if (name) {
      emitTrace(`Finished ${name}`, { data: { runId } });
      this.runIdNameMap.delete(runId);
    } else {
      // Don't emit for ignored chains like RunnableSequence
    }
  }

  override async handleChainError(
    err: any,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: { inputs?: Record<string, any> }
  ): Promise<void> {
    const name = this.runIdNameMap.get(runId);
    if (name) {
      const errorMessage = err?.message || err?.toString() || "Unknown error";
      emitTrace(`Error in ${name}: ${errorMessage}`, { data: { runId, error: err }, category: "error" });
      this.runIdNameMap.delete(runId);
    }
  }

  override async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string
  ): Promise<void> {
    const toolName = tool.id[tool.id.length - 1] || "unknown";
    emitTrace(`Using tool: ${toolName}`, { data: { input, runId } });
    this.runIdNameMap.set(runId, `tool ${toolName}`);
  }

  override async handleToolEnd(
    output: string,
    runId: string
  ): Promise<void> {
    const name = this.runIdNameMap.get(runId);
    if (name) {
      emitTrace(`Finished ${name}`, { data: { runId } });
      this.runIdNameMap.delete(runId);
    } else {
      emitTrace(`Finished tool`, { data: { runId } });
    }
  }

  override async handleToolError(
    err: any,
    runId: string
  ): Promise<void> {
    const name = this.runIdNameMap.get(runId) || "tool";
    const errorMessage = err?.message || err?.toString() || "Unknown error";
    emitTrace(`Error in ${name}: ${errorMessage}`, { data: { runId, error: err }, category: "error" });
    this.runIdNameMap.delete(runId);
  }

  override async handleLLMStart(
    llm: Serialized,
    _prompts: string[],
    runId: string
  ): Promise<void> {
    const llmName = llm.id[llm.id.length - 1] || "unknown";
    emitTrace(`Starting LLM: ${llmName}`, { data: { runId } });
    this.runIdNameMap.set(runId, `LLM ${llmName}`);
  }

  override async handleLLMEnd(
    _output: any,
    runId: string
  ): Promise<void> {
    const name = this.runIdNameMap.get(runId);
    if (name) {
      emitTrace(`Finished ${name}`, { data: { runId } });
      this.runIdNameMap.delete(runId);
    } else {
      emitTrace(`Finished LLM`, { data: { runId } });
    }
  }

  override async handleLLMError(
    err: any,
    runId: string
  ): Promise<void> {
    const name = this.runIdNameMap.get(runId) || "LLM";
    const errorMessage = err?.message || err?.toString() || "Unknown error";
    emitTrace(`Error in ${name}: ${errorMessage}`, { data: { runId, error: err }, category: "error" });
    this.runIdNameMap.delete(runId);
  }
}
