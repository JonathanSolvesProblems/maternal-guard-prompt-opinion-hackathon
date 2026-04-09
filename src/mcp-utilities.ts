import { CallToolResult } from "@modelcontextprotocol/sdk/types";

export const McpUtilities = {
  createTextResponse: (
    text: string,
    options: { isError: boolean } = { isError: false },
  ): CallToolResult => {
    return {
      content: [{ type: "text", text }],
      isError: options.isError,
    };
  },

  createJsonResponse: (
    data: unknown,
    options: { isError: boolean } = { isError: false },
  ): CallToolResult => {
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      isError: options.isError,
    };
  },
};
