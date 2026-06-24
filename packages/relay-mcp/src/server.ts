import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { TOOL_SCHEMAS, validateInput, type ToolName } from './schemas/tools.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

const toolDefinitions: ToolDefinition[] = [];
const toolHandlers = new Map<string, ToolHandler>();

export function registerTool(
  definition: ToolDefinition,
  handler: ToolHandler,
): void {
  toolDefinitions.push(definition);
  toolHandlers.set(definition.name, handler);
}

export function registerTools(
  tools: Array<{ definition: ToolDefinition; handler: ToolHandler }>,
): void {
  for (const tool of tools) {
    registerTool(tool.definition, tool.handler);
  }
}

export function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function jsonResult(data: unknown, isError = false): CallToolResult {
  return textResult(JSON.stringify(data, null, 2), isError);
}

export async function startServer(): Promise<void> {
  const server = new Server(
    { name: 'relay-mcp', version: '2.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = toolHandlers.get(name);

    if (!handler) {
      return textResult(`Unknown tool: ${name}`, true);
    }

    try {
      const schemaKey = name as ToolName;
      if (schemaKey in TOOL_SCHEMAS) {
        validateInput(schemaKey, args);
      }

      return await handler(args ?? {});
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
        return textResult(`Invalid input for ${name}: ${issues}`, true);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${name}] Error:`, message);
      return textResult(`Error in ${name}: ${message}`, true);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
