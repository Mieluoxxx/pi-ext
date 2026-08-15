export type ToolExecutionResolver = (this: PatchableToolExecutionInstance) => unknown;

export interface PatchableToolExecutionInstance {
  toolName?: unknown;
  toolDefinition?: unknown;
  [key: string]: unknown;
}

export interface McpToolExecutionPatchOptions {
  matches(instance: PatchableToolExecutionInstance): boolean;
  useDefaultShell?(instance: PatchableToolExecutionInstance): boolean;
  createCallRenderer(instance: PatchableToolExecutionInstance): unknown;
  createResultRenderer(instance: PatchableToolExecutionInstance): unknown;
}

export interface PatchableToolExecutionPrototype {
  getRenderShell: ToolExecutionResolver;
  getCallRenderer: ToolExecutionResolver;
  getResultRenderer: ToolExecutionResolver;
  __piToolDisplayMcpOriginalGetRenderShell?: ToolExecutionResolver;
  __piToolDisplayMcpOriginalGetCallRenderer?: ToolExecutionResolver;
  __piToolDisplayMcpOriginalGetResultRenderer?: ToolExecutionResolver;
  __piToolDisplayMcpPatchOptions?: McpToolExecutionPatchOptions;
  __piToolDisplayMcpPatchOwner?: object;
  __piToolDisplayMcpPatchVersion?: number;
}

const MCP_TOOL_EXECUTION_PATCH_OWNER = {};
const MCP_TOOL_EXECUTION_PATCH_VERSION = 1;

function clearPatchMetadata(prototype: PatchableToolExecutionPrototype): void {
  delete prototype.__piToolDisplayMcpOriginalGetRenderShell;
  delete prototype.__piToolDisplayMcpOriginalGetCallRenderer;
  delete prototype.__piToolDisplayMcpOriginalGetResultRenderer;
  delete prototype.__piToolDisplayMcpPatchOptions;
  delete prototype.__piToolDisplayMcpPatchOwner;
  delete prototype.__piToolDisplayMcpPatchVersion;
}

function restoreOriginalMethods(prototype: PatchableToolExecutionPrototype): void {
  const originalGetRenderShell = prototype.__piToolDisplayMcpOriginalGetRenderShell;
  const originalGetCallRenderer = prototype.__piToolDisplayMcpOriginalGetCallRenderer;
  const originalGetResultRenderer = prototype.__piToolDisplayMcpOriginalGetResultRenderer;

  if (typeof originalGetRenderShell === "function") {
    prototype.getRenderShell = originalGetRenderShell;
  }
  if (typeof originalGetCallRenderer === "function") {
    prototype.getCallRenderer = originalGetCallRenderer;
  }
  if (typeof originalGetResultRenderer === "function") {
    prototype.getResultRenderer = originalGetResultRenderer;
  }

  clearPatchMetadata(prototype);
}

export function unregisterMcpToolExecutionPatch(
  prototype: PatchableToolExecutionPrototype,
  expectedOptions?: McpToolExecutionPatchOptions,
): void {
  if (prototype.__piToolDisplayMcpPatchOwner !== MCP_TOOL_EXECUTION_PATCH_OWNER) {
    return;
  }
  if (expectedOptions && prototype.__piToolDisplayMcpPatchOptions !== expectedOptions) {
    return;
  }
  restoreOriginalMethods(prototype);
}

export function patchMcpToolExecutionPrototype(
  prototype: PatchableToolExecutionPrototype,
  options: McpToolExecutionPatchOptions,
): boolean {
  if (
    typeof prototype.getRenderShell !== "function"
    || typeof prototype.getCallRenderer !== "function"
    || typeof prototype.getResultRenderer !== "function"
  ) {
    return false;
  }

  const isCurrentPatch =
    prototype.__piToolDisplayMcpPatchOwner === MCP_TOOL_EXECUTION_PATCH_OWNER
    && prototype.__piToolDisplayMcpPatchVersion === MCP_TOOL_EXECUTION_PATCH_VERSION
    && typeof prototype.__piToolDisplayMcpOriginalGetRenderShell === "function"
    && typeof prototype.__piToolDisplayMcpOriginalGetCallRenderer === "function"
    && typeof prototype.__piToolDisplayMcpOriginalGetResultRenderer === "function";

  if (isCurrentPatch) {
    prototype.__piToolDisplayMcpPatchOptions = options;
    return true;
  }

  if (
    prototype.__piToolDisplayMcpOriginalGetRenderShell
    || prototype.__piToolDisplayMcpOriginalGetCallRenderer
    || prototype.__piToolDisplayMcpOriginalGetResultRenderer
  ) {
    restoreOriginalMethods(prototype);
  }

  const originalGetRenderShell = prototype.getRenderShell;
  const originalGetCallRenderer = prototype.getCallRenderer;
  const originalGetResultRenderer = prototype.getResultRenderer;

  prototype.__piToolDisplayMcpOriginalGetRenderShell = originalGetRenderShell;
  prototype.__piToolDisplayMcpOriginalGetCallRenderer = originalGetCallRenderer;
  prototype.__piToolDisplayMcpOriginalGetResultRenderer = originalGetResultRenderer;
  prototype.__piToolDisplayMcpPatchOptions = options;
  prototype.__piToolDisplayMcpPatchOwner = MCP_TOOL_EXECUTION_PATCH_OWNER;
  prototype.__piToolDisplayMcpPatchVersion = MCP_TOOL_EXECUTION_PATCH_VERSION;

  prototype.getRenderShell = function getMcpRenderShell(): unknown {
    try {
      const currentOptions = prototype.__piToolDisplayMcpPatchOptions;
      if (
        currentOptions?.matches(this)
        && (currentOptions.useDefaultShell?.(this) ?? true)
      ) {
        return "default";
      }
    } catch {
      // Fall through to Pi's renderer when runtime metadata is malformed.
    }
    return originalGetRenderShell.call(this);
  };

  prototype.getCallRenderer = function getMcpCallRenderer(): unknown {
    try {
      const currentOptions = prototype.__piToolDisplayMcpPatchOptions;
      if (currentOptions?.matches(this)) {
        return currentOptions.createCallRenderer(this);
      }
    } catch {
      // Fall through to Pi's renderer when decoration fails.
    }
    return originalGetCallRenderer.call(this);
  };

  prototype.getResultRenderer = function getMcpResultRenderer(): unknown {
    try {
      const currentOptions = prototype.__piToolDisplayMcpPatchOptions;
      if (currentOptions?.matches(this)) {
        return currentOptions.createResultRenderer(this);
      }
    } catch {
      // Fall through to Pi's renderer when decoration fails.
    }
    return originalGetResultRenderer.call(this);
  };

  return true;
}
